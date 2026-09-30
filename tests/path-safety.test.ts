import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertNoSymlinkPath, pathsOverlap } from "../src/path-safety.js";

test("pathsOverlap reports equal, nested and reverse-nested paths but not siblings", () => {
  const base = path.resolve("/tmp/overlap");
  assert.equal(pathsOverlap(base, base), true);
  assert.equal(pathsOverlap(base, path.join(base, "child")), true);
  assert.equal(pathsOverlap(path.join(base, "child"), base), true);
  assert.equal(pathsOverlap(path.join(base, "a"), path.join(base, "b")), false);
  assert.equal(pathsOverlap(path.join(base, "a"), path.join(base, "a-other")), false);
});

test("assertNoSymlinkPath accepts real and missing paths and names the symlinked component", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-path-safety-"));
  try {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "link"), "dir");
    await assertNoSymlinkPath(path.join(root, "real"), "test path");
    await assertNoSymlinkPath(path.join(root, "missing", "deeper"), "test path");
    await assert.rejects(
      assertNoSymlinkPath(path.join(root, "link", "child"), "test path"),
      new Error(`test path contains a symbolic link: ${path.join(root, "link")}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
