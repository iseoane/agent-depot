import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
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
