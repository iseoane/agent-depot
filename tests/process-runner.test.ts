import assert from "node:assert/strict";
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
    assert.ok(elapsed < timeoutMs + 10_000, `settled after ${elapsed}ms; the surviving grandchild kept the stdio pipes open`);
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    assert.ok(isRunning(pid), "the grandchild should have survived, otherwise the taskkill fallback was not exercised");
  });
});
