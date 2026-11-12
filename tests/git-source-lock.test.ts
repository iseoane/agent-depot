import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

import {
  GitSourceAccessAdapter,
  GitSourceAccessError,
  sourceIdForUrl,
  type GitCommandRunner,
} from "../src/git-source.js";
import { directoryLink } from "./link-helpers.js";

const source = {
  id: sourceIdForUrl("https://github.com/example/skills.git"),
  kind: "git" as const,
  url: "https://github.com/example/skills.git",
};

/** Records the Git calls and the highest number of overlapping runs. */
class OverlapRunner implements GitCommandRunner {
  readonly commands: string[] = [];
  active = 0;
  maxActive = 0;

  async run(_command: string, args: readonly string[]): Promise<void> {
    this.commands.push(args[0] ?? "");
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (args[0] === "clone") {
      await mkdir(args[args.length - 1] ?? "", { recursive: true });
    }
    this.active -= 1;
  }
}

async function withSandbox(run: (cachePath: string, lockPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-git-lock-recovery-"));
  try {
    const cachePath = path.join(directory, "cache");
    await run(cachePath, `${path.join(cachePath, source.id.slice(4))}.lock`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Runs the promises to completion on a mocked clock so a 30 s lock wait costs no real time. */
async function settleOnMockedClock(context: TestContext, ...pending: Array<Promise<unknown>>): Promise<unknown[]> {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let settled = false;
  const results = Promise.allSettled(pending).finally(() => {
    settled = true;
  });
  const realDeadline = performance.now() + 20_000;
  while (!settled) {
    if (performance.now() > realDeadline) {
      throw new Error("lock test did not settle");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(100);
  }
  return (await results).map((result) => (result.status === "fulfilled" ? undefined : result.reason));
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

async function writeOwner(lockPath: string, owner: { pid: number; hostname: string }): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ ...owner, startedAt: new Date().toISOString(), id: "previous-owner" }),
    "utf8",
  );
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

test("recovers a Source lock whose owner process on this host no longer exists", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    const runner = new OverlapRunner();

    const [error] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.equal(error, undefined);
    assert.deepEqual(runner.commands, ["clone"]);
    assert.equal(await exists(lockPath), false);
  });
});

test("keeps waiting for a lock whose owner is alive and names the owner in the error", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: process.pid, hostname: hostname() });
    const runner = new OverlapRunner();

    const [error] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.ok(error instanceof GitSourceAccessError);
    assert.match(error.message, /another refresh might be active/);
    assert.ok(error.message.includes(String(process.pid)), error.message);
    assert.ok(error.message.includes(hostname()), error.message);
    assert.deepEqual(runner.commands, []);
    assert.match(await readFile(path.join(lockPath, "owner.json"), "utf8"), /previous-owner/);
  });
});

test("never recovers a lock owned by another host even when its pid does not exist here", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: `${hostname()}-other` });
    const runner = new OverlapRunner();

    const [error] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.ok(error instanceof GitSourceAccessError);
    assert.deepEqual(runner.commands, []);
    assert.equal(await exists(lockPath), true);
  });
});

test("serializes two concurrent refreshes that find the same orphaned lock", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    const runner = new OverlapRunner();
    const first = new GitSourceAccessAdapter({ cachePath, runner }).refresh(source);
    const second = new GitSourceAccessAdapter({ cachePath, runner }).refresh(source);

    // Real timers: a mocked clock advances per event-loop turn, which would age the waiter's 30 s deadline under load.
    await Promise.all([first, second]);

    assert.equal(runner.commands.length, 2);
    assert.equal(runner.maxActive, 1);
    assert.equal(await exists(lockPath), false);
  });
});

test("recovers an old lock without an owner file but not a recent one", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await mkdir(lockPath, { recursive: true });
    const recent = new Date(Date.now() - 60_000);
    await utimes(lockPath, recent, recent);
    const [recentError] = await settleOnMockedClock(
      context,
      new GitSourceAccessAdapter({ cachePath, runner: new OverlapRunner() }).refresh(source),
    );
    assert.ok(recentError instanceof GitSourceAccessError);
    assert.equal(await exists(lockPath), true);
    context.mock.timers.reset();

    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lockPath, old, old);
    const runner = new OverlapRunner();
    const [oldError] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.equal(oldError, undefined);
    assert.deepEqual(runner.commands, ["clone"]);
    assert.equal(await exists(lockPath), false);
  });
});

test("recovering an orphaned lock does not follow links inside it", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    const outside = path.join(path.dirname(cachePath), "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep", "utf8");
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    await directoryLink(outside, path.join(lockPath, "link"));

    const [error] = await settleOnMockedClock(
      context,
      new GitSourceAccessAdapter({ cachePath, runner: new OverlapRunner() }).refresh(source),
    );

    assert.equal(error, undefined);
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  });
});

function gate(): { readonly opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Holds the lock inside its Git run until the test opens the release gate. */
class GatedRunner extends OverlapRunner {
  readonly running = gate();
  readonly release = gate();

  override async run(command: string, args: readonly string[]): Promise<void> {
    this.running.open();
    await this.release.opened;
    await super.run(command, args);
  }
}

test("a recoverer holding a stale judgment does not remove or move a lock another process took", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    const paused = gate();
    const resume = gate();
    const slow = new GitSourceAccessAdapter({
      cachePath,
      runner: new OverlapRunner(),
      lockHooks: {
        afterJudging: async () => {
          paused.open();
          await resume.opened;
        },
      },
    }).refresh(source);
    await paused.opened;

    const holderRunner = new GatedRunner();
    const holder = new GitSourceAccessAdapter({ cachePath, runner: holderRunner }).refresh(source);
    await holderRunner.running.opened;
    const liveOwner = await readFile(path.join(lockPath, "owner.json"), "utf8");

    resume.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), liveOwner);
    holderRunner.release.open();
    await Promise.all([slow, holder]);
    assert.equal(await exists(lockPath), false);
  });
});

test("a failed owner write never deletes a lock another process holds", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    const otherHolder = path.join(lockPath, "owner.json");
    const runner = new OverlapRunner();
    const refresh = new GitSourceAccessAdapter({
      cachePath,
      runner,
      lockHooks: {
        afterLockCreated: async () => {
          // Someone else now holds the lock; its owner record cannot be replaced by ours.
          await rm(lockPath, { recursive: true, force: true });
          await mkdir(path.join(otherHolder, "held"), { recursive: true });
        },
      },
    }).refresh(source);

    await assert.rejects(refresh, GitSourceAccessError);

    assert.equal(await exists(path.join(otherHolder, "held")), true);
    assert.deepEqual(runner.commands, []);
  });
});

test("a recent recovery mutex held by another process keeps an orphaned lock in place", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    await mkdir(`${lockPath}.recovering`);
    const runner = new OverlapRunner();

    const [error] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.ok(error instanceof GitSourceAccessError);
    assert.deepEqual(runner.commands, []);
    assert.equal(await exists(lockPath), true);
  });
});

test("reclaims an orphaned recovery mutex and then recovers the lock", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    await mkdir(`${lockPath}.recovering`);
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(`${lockPath}.recovering`, old, old);
    const runner = new OverlapRunner();

    const [error] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.equal(error, undefined);
    assert.deepEqual(runner.commands, ["clone"]);
    assert.equal(await exists(`${lockPath}.recovering`), false);
  });
});

test("does not recover a lock whose owner record cannot be read", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await mkdir(path.join(lockPath, "owner.json"), { recursive: true });
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lockPath, old, old);
    const runner = new OverlapRunner();

    const [error] = await settleOnMockedClock(context, new GitSourceAccessAdapter({ cachePath, runner }).refresh(source));

    assert.ok(error instanceof GitSourceAccessError);
    assert.deepEqual(runner.commands, []);
    assert.equal(await exists(lockPath), true);
  });
});

test("two real processes refreshing over an orphaned lock run one at a time", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    const logPath = path.join(path.dirname(cachePath), "child.log");
    const child = fileURLToPath(new URL("./fixtures/source-lock-child.js", import.meta.url));
    const run = promisify(execFile);

    await Promise.all(["a", "b"].map((label) => run(process.execPath, [child, cachePath, logPath, label])));

    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => line.split(" ")[1]);
    assert.deepEqual(events, ["start", "end", "start", "end"]);
    assert.equal(await exists(lockPath), false);
  });
});

test("a holder that lost its lock before publishing its owner record leaves the successor's record and runs no Git", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    const paused = gate();
    const resume = gate();
    const staleRunner = new OverlapRunner();
    const stale = new GitSourceAccessAdapter({
      cachePath,
      runner: staleRunner,
      lockHooks: {
        afterLockCreated: async () => {
          paused.open();
          await resume.opened;
        },
      },
    }).refresh(source);
    await paused.opened;

    // The paused holder's ownerless lock ages out, so a successor recovers it and takes the lock.
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lockPath, old, old);
    const successorRunner = new GatedRunner();
    const successor = new GitSourceAccessAdapter({ cachePath, runner: successorRunner }).refresh(source);
    await successorRunner.running.opened;
    const liveOwner = await readFile(path.join(lockPath, "owner.json"), "utf8");

    resume.open();
    const error = await stale.then(() => undefined, (reason: unknown) => reason);

    assert.ok(error instanceof GitSourceAccessError);
    assert.match(error.message, /taken over/);
    assert.deepEqual(staleRunner.commands, []);
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), liveOwner);
    successorRunner.release.open();
    await successor;
    assert.equal(await exists(lockPath), false);
  });
});

test("a holder whose owner record was replaced before it runs Git stops without running it", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    const runner = new OverlapRunner();
    const otherOwner = JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), id: "successor" });
    const refresh = new GitSourceAccessAdapter({
      cachePath,
      runner,
      lockHooks: {
        afterLockAcquired: async () => {
          await writeFile(path.join(lockPath, "owner.json"), otherOwner, "utf8");
        },
      },
    }).refresh(source);

    const error = await refresh.then(() => undefined, (reason: unknown) => reason);

    assert.ok(error instanceof GitSourceAccessError);
    assert.match(error.message, /taken over/);
    assert.deepEqual(runner.commands, []);
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), otherOwner);
  });
});

test("a recoverer whose mutex was reclaimed by another does not remove the lock that process took", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    const paused = gate();
    const resume = gate();
    const slow = new GitSourceAccessAdapter({
      cachePath,
      runner: new OverlapRunner(),
      lockHooks: {
        beforeOrphanRemoval: async () => {
          paused.open();
          await resume.opened;
        },
      },
    }).refresh(source);
    await paused.opened;

    // The paused recoverer looks dead: its mutex ages out and a second recoverer takes over and re-takes the lock.
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(`${lockPath}.recovering`, old, old);
    const successorRunner = new GatedRunner();
    const successor = new GitSourceAccessAdapter({ cachePath, runner: successorRunner }).refresh(source);
    await successorRunner.running.opened;
    const liveOwner = await readFile(path.join(lockPath, "owner.json"), "utf8");

    resume.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), liveOwner);
    successorRunner.release.open();
    await Promise.all([slow, successor]);
    assert.equal(await exists(lockPath), false);
  });
});

/** Fails the first removal of `lockPath` after handing the lock to a live successor, as a transient Windows error would. */
function failFirstRemovalAfterSuccessorTakes(lockPath: string, successorId: string): { removals: string[]; remove: (directory: string) => Promise<void> } {
  const removals: string[] = [];
  return {
    removals,
    remove: async (directory) => {
      removals.push(directory);
      if (directory !== lockPath || removals.filter((removed) => removed === lockPath).length > 1) {
        await rm(directory, { recursive: true, force: true });
        return;
      }
      await rm(lockPath, { recursive: true, force: true });
      await writeOwner(lockPath, { pid: process.pid, hostname: hostname() });
      await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), id: successorId }),
        "utf8",
      );
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
  };
}

test("retrying the release of a lock never removes a successor's lock", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    const interleaving = failFirstRemovalAfterSuccessorTakes(lockPath, "successor");

    await new GitSourceAccessAdapter({
      cachePath,
      runner: new OverlapRunner(),
      lockHooks: { removeDirectory: interleaving.remove },
    }).refresh(source);

    assert.match(await readFile(path.join(lockPath, "owner.json"), "utf8"), /successor/);
  });
});

test("retrying the removal of an orphan never removes a lock a successor took", async (context) => {
  await withSandbox(async (cachePath, lockPath) => {
    await writeOwner(lockPath, { pid: await deadPid(), hostname: hostname() });
    const interleaving = failFirstRemovalAfterSuccessorTakes(lockPath, "successor");
    const runner = new OverlapRunner();

    await settleOnMockedClock(
      context,
      new GitSourceAccessAdapter({ cachePath, runner, lockHooks: { removeDirectory: interleaving.remove } }).refresh(source),
    );

    assert.match(await readFile(path.join(lockPath, "owner.json"), "utf8"), /successor/);
    assert.deepEqual(runner.commands, []);
  });
});

test("a holder whose lock vanished before it wrote its owner record reports the takeover", async () => {
  await withSandbox(async (cachePath, lockPath) => {
    const runner = new OverlapRunner();
    const refresh = new GitSourceAccessAdapter({
      cachePath,
      runner,
      lockHooks: {
        afterLockCreated: async () => {
          await rm(lockPath, { recursive: true, force: true });
        },
      },
    }).refresh(source);

    const error = await refresh.then(() => undefined, (reason: unknown) => reason);

    assert.ok(error instanceof GitSourceAccessError);
    assert.match(error.message, /taken over/);
    assert.deepEqual(runner.commands, []);
  });
});
