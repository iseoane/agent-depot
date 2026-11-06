import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WINDOWS_RENAME_ATTEMPTS, renameWithWindowsRetry, writeFileAtomically } from "../src/atomic-file.js";

test("concurrent atomic writes to one file all succeed and leave one complete file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-atomic-"));
  try {
    const file = path.join(directory, "receipt.json");
    for (let round = 0; round < 40; round += 1) {
      const contents = Array.from({ length: 8 }, (_, writer) => `{"round":${round},"writer":${writer}}`);
      await Promise.all(contents.map((body) => writeFileAtomically(file, body)));
      assert.ok(contents.includes(await readFile(file, "utf8")));
    }
    assert.deepEqual(await readdir(directory), ["receipt.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function retryDeps(platform: NodeJS.Platform, failures: number, code = "EPERM") {
  const calls = { rename: 0, delays: 0 };
  return {
    calls,
    deps: {
      platform,
      rename: async () => {
        calls.rename += 1;
        if (calls.rename <= failures) throw errno(code);
      },
      delay: async () => { calls.delays += 1; },
    },
  };
}

test("a transient Windows rename error is retried until the rename succeeds", async () => {
  const { calls, deps } = retryDeps("win32", 3);
  await renameWithWindowsRetry("from", "to", deps);
  assert.equal(calls.rename, 4);
  assert.equal(calls.delays, 3);
});

test("a persistent Windows rename error is rethrown after exactly the attempt bound", async () => {
  const { calls, deps } = retryDeps("win32", Infinity);
  await assert.rejects(renameWithWindowsRetry("from", "to", deps), { code: "EPERM" });
  assert.equal(calls.rename, WINDOWS_RENAME_ATTEMPTS);
});

test("non-transient codes and non-Windows platforms are not retried", async () => {
  const other = retryDeps("win32", Infinity, "ENOENT");
  await assert.rejects(renameWithWindowsRetry("from", "to", other.deps), { code: "ENOENT" });
  assert.equal(other.calls.rename, 1);
  const linux = retryDeps("linux", Infinity);
  await assert.rejects(renameWithWindowsRetry("from", "to", linux.deps), { code: "EPERM" });
  assert.equal(linux.calls.rename, 1);
});
