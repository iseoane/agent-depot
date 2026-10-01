import assert from "node:assert/strict";
import { test } from "node:test";

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

test("rejects when the command cannot be spawned", async () => {
  await assert.rejects(runProcess("definitely-not-a-real-command-xyz", []), /ENOENT/);
});

test("caps stderr as well as stdout and closes stdin for non-interactive commands", async () => {
  const oversized = await runProcess(node, ["-e", "process.stderr.write('x'.repeat(100000));setTimeout(()=>{},5000)"], {
    maxOutputBytes: 32,
  });
  assert.equal(oversized.outputTooLarge, true);
  assert.ok(Buffer.byteLength(oversized.stderr) <= 32);
  const input = await runProcess(node, ["-e", "process.stdin.on('end',()=>process.stdout.write('eof'));process.stdin.resume()"], {
    captureStdout: true,
  });
  assert.equal(input.stdout.toString(), "eof");
});
