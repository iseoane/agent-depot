import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("pathsOverlap treats dot-dot prefixed names as children and normalizes traversal segments", () => {
  const base = path.resolve("/tmp/overlap");
  assert.equal(pathsOverlap(base, path.join(base, "..hidden")), true);
  assert.equal(pathsOverlap(base, path.join(base, "child", "..", "other")), true);
  assert.equal(pathsOverlap(path.join(base, "child", ".."), base), true);
  assert.equal(pathsOverlap(base, path.resolve(base, "..")), true);
  assert.equal(pathsOverlap(base, path.resolve(base, "..", "overlap-sibling")), false);
  assert.equal(pathsOverlap(path.parse(base).root, base), true);
});

test("assertNoSymlinkPath normalizes traversal and resolves relative candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-path-safety-"));
  try {
    await mkdir(path.join(root, "real", "nested"), { recursive: true });
    await symlink(path.join(root, "real"), path.join(root, "link"), "dir");
    // A ".." segment collapses before any component is inspected, so the link is never walked.
    await assertNoSymlinkPath(path.join(root, "link", "..", "real", "nested"), "test path");
    const previous = process.cwd();
    process.chdir(root);
    try {
      await assertNoSymlinkPath(path.join("real", "nested"), "relative path");
      await assert.rejects(
        assertNoSymlinkPath(path.join("link", "nested"), "relative path"),
        /relative path contains a symbolic link: .*link$/,
      );
    } finally {
      process.chdir(previous);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoSymlinkPath rejects a symlinked leaf, a dangling link and the first link of several", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-path-safety-"));
  try {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "outer"), "dir");
    await symlink(path.join(root, "missing-target"), path.join(root, "dangling"));
    await assert.rejects(
      assertNoSymlinkPath(path.join(root, "outer"), "leaf"),
      new Error(`leaf contains a symbolic link: ${path.join(root, "outer")}`),
    );
    await assert.rejects(
      assertNoSymlinkPath(path.join(root, "dangling", "child"), "dangling"),
      new Error(`dangling contains a symbolic link: ${path.join(root, "dangling")}`),
    );
    await symlink(path.join(root, "outer"), path.join(root, "real", "inner"), "dir");
    await assert.rejects(
      assertNoSymlinkPath(path.join(root, "outer", "inner", "x"), "chain"),
      new Error(`chain contains a symbolic link: ${path.join(root, "outer")}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoSymlinkPath accepts the filesystem root and surfaces non-ENOENT errors", async () => {
  await assertNoSymlinkPath(path.parse(process.cwd()).root, "root");
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-path-safety-"));
  try {
    await writeFile(path.join(root, "file"), "x");
    // A regular file used as a directory yields ENOTDIR, which is not treated as a missing path.
    await assert.rejects(
      assertNoSymlinkPath(path.join(root, "file", "child"), "file parent"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
