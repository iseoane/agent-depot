import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  compareSkillTrees,
  readExistingSkillTree,
  type SkillTreeFileSystem,
} from "../src/skill-adoption.js";
import type { SkillTreeFile } from "../src/skill-discovery.js";

const expected: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Uint8Array.from([1, 2]), executable: false },
  { path: "portable/demo/bin/run.sh", content: Uint8Array.from([3, 4]), executable: true },
];

const fileSystem: SkillTreeFileSystem = {
  lstat,
  async readdir(candidate) { return readdir(candidate); },
  async readFile(candidate) { return readFile(candidate); },
};

test("compares Skill trees by exact relative paths and bytes", () => {
  assert.deepEqual(compareSkillTrees(expected, expected), { identical: true });
  assert.deepEqual(compareSkillTrees(expected, [
    { ...expected[0], content: Uint8Array.from([1, 9]) },
    expected[1],
  ]), { identical: false, reason: "content-mismatch" });
  assert.deepEqual(compareSkillTrees(expected, [expected[0]]), { identical: false, reason: "missing-file" });
  assert.deepEqual(compareSkillTrees(expected, [...expected, {
    path: "portable/demo/extra.txt", content: Uint8Array.from([5]), executable: false,
  }]), { identical: false, reason: "extra-file" });
});

test("reads an existing tree without following symlinks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-adoption-"));
  try {
    await mkdir(path.join(root, "bin"));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "SKILL.md"), "skill"));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "bin", "run.sh"), "run"));
    await chmod(path.join(root, "bin", "run.sh"), 0o755);
    const tree = await readExistingSkillTree(root, "portable/demo", fileSystem);
    assert.deepEqual(tree.map((file) => file.path), ["portable/demo/bin/run.sh", "portable/demo/SKILL.md"]);
    assert.equal(tree.find((file) => file.path.endsWith("bin/run.sh"))?.executable, true);

    try {
      await symlink(path.join(root, "SKILL.md"), path.join(root, "link"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(readExistingSkillTree(root, "portable/demo", fileSystem), /symbolic link/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
