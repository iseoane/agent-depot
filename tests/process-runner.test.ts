import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runProcess } from "../src/process-runner.js";

const node = process.execPath;

test("resolves with exit code and captured stdout and stderr", async () => {
  const result = await runProcess(node, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"], {
    captureStdout: true,
  });
  assert.equal(result.code, 3);
  assert.equal(result.signal, null);
  assert.equal(Buffer.from(result.stdout).toString("utf8"), "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.outputTooLarge, false);
});

test("does not capture stdout unless requested and honors cwd", async () => {
  const result = await runProcess(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: process.cwd() });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
});

test("kills the process and flags output above the byte limit", async () => {
  const result = await runProcess(node, ["-e", "process.stdout.write('x'.repeat(100000));setTimeout(()=>{},5000)"], {
    captureStdout: true,
    maxOutputBytes: 10,
  });
  assert.equal(result.outputTooLarge, true);
});

test("kills a process that exceeds its time budget", async () => {
  const result = await runProcess(node, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 20 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("rejects when the command cannot be spawned", async () => {
  await assert.rejects(runProcess("definitely-not-a-real-command-xyz", []), /ENOENT/);
});

test("caps stderr as well as stdout and closes stdin for non-interactive commands", async () => {
  const oversized = await runProcess(node, ["-e", "process.stderr.write('x'.repeat(100000));setTimeout(()=>{},5000)"], {
    maxStderrBytes: 32,
  });
  assert.equal(oversized.outputTooLarge, true);
  assert.ok(Buffer.byteLength(oversized.stderr) <= 32);
  const input = await runProcess(node, ["-e", "process.stdin.on('end',()=>process.stdout.write('eof'));process.stdin.resume()"], {
    captureStdout: true,
  });
  assert.equal(input.stdout.toString(), "eof");
});

test("a stdout-only byte limit permits large stderr warnings", async () => {
  const result = await runProcess(node, ["-e", "process.stdout.write('ok');process.stderr.write('w'.repeat(100000))"], {
    captureStdout: true,
    maxOutputBytes: 128,
  });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.outputTooLarge, false);
  assert.equal(result.stdout.toString(), "ok");
  assert.equal(result.stderr.length, 100000);
});

const win32Only = process.platform !== "win32" && "needs cmd.exe and taskkill to run a real batch file";
/** The grandchild would outlive the test by a minute if nothing killed it. */
const GRANDCHILD_LIFETIME_MS = 60_000;

interface BatchGrandchild {
  readonly shim: string;
  readonly pidFile: string;
}

/**
 * A `.cmd` (like an npm cmd-shim) whose cmd.exe parent launches a node
 * grandchild; the grandchild records its pid, optionally floods stdout, then
 * sleeps while holding the inherited stdio pipes open.
 */
async function withBatchGrandchild(
  floodStdout: boolean,
  run: (grandchild: BatchGrandchild) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-kill-tree-"));
  const pidFile = path.join(directory, "grandchild.pid");
  let pid: number | undefined;
  try {
    const script = path.join(directory, "sleeper.cjs");
    const shim = path.join(directory, "sleeper.cmd");
    await writeFile(script, [
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid));",
      floodStdout ? "process.stdout.write('x'.repeat(100000));" : "",
      `setTimeout(() => {}, ${GRANDCHILD_LIFETIME_MS});`,
    ].join("\n"));
    await writeFile(shim, `@"${process.execPath}" "${script}" "${pidFile}"\r\n`);
    try {
      await run({ shim, pidFile });
    } finally {
      pid = await readFile(pidFile, "utf8").then((text) => Number(text), () => undefined);
    }
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertGrandchildGone(pidFile: string): Promise<void> {
  const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
  assert.ok(Number.isInteger(pid) && pid > 0, "the grandchild never recorded its pid");
  const deadline = Date.now() + 10_000;
  while (isRunning(pid) && Date.now() < deadline) await delay(100);
  assert.equal(isRunning(pid), false, `grandchild ${pid} is still running`);
}

test("on win32 a timeout terminates the whole process tree of a batch file within a bound", { skip: win32Only }, async () => {
  await withBatchGrandchild(false, async ({ shim, pidFile }) => {
    const timeoutMs = 5_000;
    const started = Date.now();
    const result = await runProcess(shim, [], { timeoutMs });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    assert.ok(elapsed < timeoutMs + 10_000, `settled after ${elapsed}ms; the grandchild kept the stdio pipes open`);
    await assertGrandchildGone(pidFile);
  });
});

test("on win32 output overflow terminates the whole process tree of a batch file within a bound", { skip: win32Only }, async () => {
  await withBatchGrandchild(true, async ({ shim, pidFile }) => {
    const started = Date.now();
    const result = await runProcess(shim, [], { captureStdout: true, maxOutputBytes: 10, timeoutMs: 30_000 });
    const elapsed = Date.now() - started;
    assert.equal(result.outputTooLarge, true);
    assert.equal(result.timedOut, undefined);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    assert.ok(elapsed < 20_000, `settled after ${elapsed}ms; the grandchild kept the stdio pipes open`);
    await assertGrandchildGone(pidFile);
  });
});

test("on win32 the result is still returned within a bound when taskkill is unavailable and a grandchild survives", { skip: win32Only }, async () => {
  await withBatchGrandchild(false, async ({ shim, pidFile }) => {
    const timeoutMs = 5_000;
    const started = Date.now();
    const pending = runProcess(shim, [], { timeoutMs });
    // The child has been spawned with the real environment; point the later kill at a missing taskkill.
    const previous = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    process.env.SystemRoot = process.env.windir = path.join(tmpdir(), "agent-depot-no-such-system-root");
    let result: Awaited<typeof pending>;
    try {
      result = await pending;
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    assert.ok(elapsed < timeoutMs + 10_000, `settled after ${elapsed}ms; the surviving grandchild kept the stdio pipes open`);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    assert.ok(Number.isInteger(pid) && pid > 0, "the grandchild never recorded its pid");
    assert.ok(isRunning(pid), "the grandchild should have survived, otherwise the taskkill fallback was not exercised");
  });
});

const posixOnly = process.platform === "win32" && "relies on POSIX process semantics (sh, kill(2))";
/** Generous bound on how long a runner kill may take to settle after the timeout fires (SIGTERM grace, SIGKILL, give-up). */
const POSIX_SETTLE_BOUND_MS = 9_000;

interface PosixSleeper {
  readonly script: string;
  readonly pidFile: string;
}

/**
 * A node script that optionally ignores SIGTERM, records its pid (after the handler is installed, so
 * a recorded pid means the signal is already ignored), optionally floods stdout, then sleeps while
 * holding the inherited stdio pipes open. The pid is always killed afterwards.
 */
async function withPosixSleeper(
  options: { readonly floodStdout?: boolean; readonly ignoreSigterm?: boolean },
  run: (sleeper: PosixSleeper) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-kill-tree-"));
  const pidFile = path.join(directory, "sleeper.pid");
  const script = path.join(directory, "sleeper.cjs");
  try {
    await writeFile(script, [
      options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : "",
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid));",
      options.floodStdout ? "process.stdout.write('x'.repeat(100000));" : "",
      `setTimeout(() => {}, ${GRANDCHILD_LIFETIME_MS});`,
    ].join("\n"));
    try {
      await run({ script, pidFile });
    } finally {
      const pid = await readFile(pidFile, "utf8").then((text) => Number(text), () => undefined);
      if (pid !== undefined) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Fails instead of hanging when `pending` does not settle in time (the runner never resolves while a descendant holds the pipes). */
async function settlesWithin<T>(pending: Promise<T>, boundMs: number): Promise<T> {
  const hung = Symbol("hung");
  const outcome = await Promise.race([pending, delay(boundMs, hung)]);
  assert.notEqual(outcome, hung, `runProcess had not settled after ${boundMs}ms; a descendant kept the stdio pipes open`);
  return outcome as T;
}

/** `sh` runs the sleeper as a child and then `:`, so it forks instead of exec'ing it. */
const FORKING_WRAPPER = ['"$0" "$1" "$2"; :'];

test("on POSIX a timeout terminates a forked descendant that holds the stdio pipes within a bound", { skip: posixOnly, timeout: 60_000 }, async () => {
  await withPosixSleeper({}, async ({ script, pidFile }) => {
    const timeoutMs = 1_000;
    const started = Date.now();
    const result = await settlesWithin(
      runProcess("sh", ["-c", ...FORKING_WRAPPER, node, script, pidFile], { timeoutMs }),
      timeoutMs + POSIX_SETTLE_BOUND_MS,
    );
    assert.equal(result.timedOut, true);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    assert.ok(Date.now() - started < timeoutMs + POSIX_SETTLE_BOUND_MS);
    await assertGrandchildGone(pidFile);
  });
});

test("on POSIX output overflow terminates a forked descendant that holds the stdio pipes within a bound", { skip: posixOnly, timeout: 60_000 }, async () => {
  await withPosixSleeper({ floodStdout: true }, async ({ script, pidFile }) => {
    const result = await settlesWithin(
      runProcess("sh", ["-c", ...FORKING_WRAPPER, node, script, pidFile], { captureStdout: true, maxOutputBytes: 10, timeoutMs: 30_000 }),
      POSIX_SETTLE_BOUND_MS,
    );
    assert.equal(result.outputTooLarge, true);
    assert.equal(result.timedOut, undefined);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    await assertGrandchildGone(pidFile);
  });
});

test("on POSIX a child that ignores SIGTERM is killed after a grace period and reported as terminated", { skip: posixOnly, timeout: 60_000 }, async () => {
  await withPosixSleeper({ ignoreSigterm: true }, async ({ script, pidFile }) => {
    const timeoutMs = 1_000;
    const result = await settlesWithin(runProcess(node, [script, pidFile], { timeoutMs }), timeoutMs + POSIX_SETTLE_BOUND_MS);
    assert.equal(result.timedOut, true);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    await assertGrandchildGone(pidFile);
  });
});

test("on POSIX the result is still returned within a bound when a descendant has left the process tree and holds the pipes", { skip: posixOnly, timeout: 60_000 }, async () => {
  await withPosixSleeper({}, async ({ script, pidFile }) => {
    const timeoutMs = 1_000;
    // The subshell exits at once and orphans the sleeper, so it is no longer a descendant of the child when the kill comes.
    const result = await settlesWithin(
      runProcess("sh", ["-c", '("$0" "$1" "$2" &); sleep 60', node, script, pidFile], { timeoutMs }),
      timeoutMs + POSIX_SETTLE_BOUND_MS,
    );
    assert.equal(result.timedOut, true);
    assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    assert.ok(Number.isInteger(pid) && pid > 0, "the sleeper never recorded its pid");
    assert.ok(isRunning(pid), "the sleeper should have survived, otherwise the bounded settle was not exercised");
  });
});

test("on POSIX a timeout still kills the child and settles when the process list cannot be read", { skip: posixOnly, timeout: 60_000 }, async () => {
  await withPosixSleeper({}, async ({ script, pidFile }) => {
    const timeoutMs = 1_000;
    const pending = runProcess(node, [script, pidFile], { timeoutMs });
    // The child has been spawned with the real PATH; the later `ps` for the process tree finds nothing.
    const emptyPath = await mkdtemp(path.join(tmpdir(), "agent-depot-no-ps-"));
    const previous = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      const result = await settlesWithin(pending, timeoutMs + POSIX_SETTLE_BOUND_MS);
      assert.equal(result.timedOut, true);
      assert.deepEqual([result.code, result.signal], [null, "SIGTERM"]);
      await assertGrandchildGone(pidFile);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(emptyPath, { recursive: true, force: true });
    }
  });
});

/** Non-regression guard (green before the fix too): see the Ctrl-C test below. */
const SIGINT_DRIVER = [
  "import(process.argv[1]).then(({ runProcess }) =>",
  "  runProcess('sh', ['-c', '\"$0\" \"$1\" \"$2\"; :', process.argv[2], process.argv[3], process.argv[4]]));",
].join("\n");

test("on POSIX a terminal SIGINT to the foreground process group still stops the child (non-regression guard)", { skip: posixOnly, timeout: 60_000 }, async () => {
  await withPosixSleeper({}, async ({ script, pidFile }) => {
    const runner = new URL("../src/process-runner.js", import.meta.url).href;
    // Its own process group stands in for the terminal's foreground group; the test runner stays outside it.
    const driver = spawn(node, ["-e", SIGINT_DRIVER, runner, node, script, pidFile], { detached: true, stdio: "ignore" });
    try {
      const deadline = Date.now() + 10_000;
      while (!(await readFile(pidFile, "utf8").then(() => true, () => false)) && Date.now() < deadline) await delay(50);
      // What a terminal does on Ctrl-C: SIGINT to every process of the foreground group.
      process.kill(-(driver.pid as number), "SIGINT");
      await once(driver, "close");
      await assertGrandchildGone(pidFile);
    } finally {
      try { process.kill(-(driver.pid as number), "SIGKILL"); } catch { /* already gone */ }
    }
  });
});
