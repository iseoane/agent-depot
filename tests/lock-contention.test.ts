import assert from "node:assert/strict";
import { test } from "node:test";

import { isLockContention } from "../src/atomic-file.js";

const failure = (code: string) => Object.assign(new Error(code), { code });

test("an existing lock directory is contention on every platform", () => {
  for (const platform of ["linux", "win32"] as const) assert.equal(isLockContention(failure("EEXIST"), platform), true);
});

test("EPERM and EACCES are contention only on Windows, where mkdir fails that way while a rmdir completes", () => {
  for (const code of ["EPERM", "EACCES"]) {
    assert.equal(isLockContention(failure(code), "win32"), true, code);
    assert.equal(isLockContention(failure(code), "linux"), false, code);
  }
});

test("other failures and non-errors are not contention", () => {
  assert.equal(isLockContention(failure("ENOENT"), "win32"), false);
  assert.equal(isLockContention("EEXIST", "win32"), false);
  assert.equal(isLockContention(undefined, "win32"), false);
});
