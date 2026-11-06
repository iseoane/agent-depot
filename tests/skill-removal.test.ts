import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectSkillSelection } from "../src/project-manifest.js";
import { ProjectInstallationError, type ProjectInstallationFileSystem } from "../src/project-installation.js";
import { planSkillRemoval, SkillSelectionError, selectUserGlobalSkills, userGlobalRemovalOptions } from "../src/skill-removal.js";
import { directoryLink } from "./link-helpers.js";

const record = (sourceId: string, skillPath: string, installationPath = ".agents/skills/demo"): ProjectSkillSelection => ({
  source: sourceId === "builtin" ? { kind: "builtin", id: "builtin:agent-depot" } : { kind: "external", url: sourceId },
  path: skillPath,
  version: { policy: "latest" },
  hosts: ["pi"],
  installation: { path: installationPath, adopted: false },
});

async function withRoot(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-missing-removal-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function testFileSystem(lstatPath: (candidate: string) => Promise<Stats>): ProjectInstallationFileSystem {
  return {
    lstat: lstatPath,
    readdir: async (candidate) => readdir(candidate),
    readFile: async (candidate) => readFile(candidate),
    mkdir: async (candidate) => { await mkdir(candidate); },
    writeFile: async (candidate, content) => { await writeFile(candidate, content); },
    chmod,
    symlink: async (target, candidate) => { await directoryLink(target, candidate); },
    readlink,
    rm: async (candidate) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
    unlink,
    rename,
  };
}

test("selectUserGlobalSkills treats duplicate exact paths as ambiguous", () => {
  const installations = [record("builtin", "portable/demo"), record("https://example.com/skills.git", "portable/demo")];
  assert.throws(
    () => selectUserGlobalSkills(installations, ["portable/demo"]),
    (error: unknown) => error instanceof SkillSelectionError && /Ambiguous user-global Skill "portable\/demo"/u.test(error.message),
  );
});

test("selectUserGlobalSkills resolves a unique exact path over same-named paths", () => {
  const installations = [record("builtin", "a/demo"), record("builtin", "demo")];
  assert.deepEqual(selectUserGlobalSkills(installations, ["demo"]), [installations[1]]);
});

test("missing-record inspection accepts absent intermediate skill-root directories", async () => {
  await withRoot(async (root) => {
    const plan = await planSkillRemoval([record("builtin", "portable/demo")], userGlobalRemovalOptions(root));
    assert.equal(plan.inspections[0]?.recordOnly, true);
    assert.match(plan.preview.join("\n"), /record only; no files removed/u);
  });
});

test("missing-record inspection rejects an unsafe recorded path", async () => {
  await withRoot(async (root) => {
    for (const installationPath of ["../../outside", ".git/config/demo"]) {
      await assert.rejects(
        planSkillRemoval([record("builtin", "portable/demo", installationPath)], userGlobalRemovalOptions(root)),
        (error: unknown) => error instanceof ProjectInstallationError && error.code === "unsafe-target",
      );
    }
  });
});

test("missing-record inspection propagates non-ENOENT filesystem errors", async () => {
  await withRoot(async (root) => {
    const target = path.join(root, ".agents", "skills", "demo");
    const fileSystem = testFileSystem(async (candidate) => {
      if (candidate === target) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return lstat(candidate);
    });
    await assert.rejects(
      planSkillRemoval([record("builtin", "portable/demo")], userGlobalRemovalOptions(root, { fileSystem })),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "EACCES",
    );
  });
});

test("missing-record inspection rejects a synthetic symlink ancestor", async () => {
  await withRoot(async (root) => {
    const symlinkDirectory = path.join(root, ".agents");
    const symbolic = await lstat(root);
    symbolic.isSymbolicLink = () => true;
    const fileSystem = testFileSystem(async (candidate) => candidate === symlinkDirectory ? symbolic : lstat(candidate));
    await assert.rejects(
      planSkillRemoval([record("builtin", "portable/demo")], userGlobalRemovalOptions(root, { fileSystem })),
      (error: unknown) => error instanceof ProjectInstallationError && error.code === "unsafe-target",
    );
  });
});

test("missing-record inspection refuses a potential dangling Claude link even when unrecorded", async () => {
  await withRoot(async (root) => {
    const claudeLocation = path.join(root, ".claude", "skills", "demo");
    const danglingLink = await lstat(root);
    danglingLink.isSymbolicLink = () => true;
    const fileSystem = testFileSystem(async (candidate) => candidate === claudeLocation ? danglingLink : lstat(candidate));
    await assert.rejects(
      planSkillRemoval([record("builtin", "portable/demo")], userGlobalRemovalOptions(root, { fileSystem })),
      (error: unknown) => error instanceof ProjectInstallationError && error.code === "unsafe-target" && /filesystem object exists/u.test(error.message),
    );
  });
});

test("missing-record inspection refuses selected alias records with overlapping install paths", async () => {
  await withRoot(async (root) => {
    const first = record("builtin", "portable/demo");
    const alias = record("https://example.com/skills.git", "portable/alias", ".agents/skills/demo");
    await assert.rejects(
      planSkillRemoval([first, alias], userGlobalRemovalOptions(root)),
      (error: unknown) => error instanceof ProjectInstallationError && error.code === "overlapping-targets",
    );
  });
});
