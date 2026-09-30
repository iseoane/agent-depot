import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertNoOverlappingUserGlobalSkillRemovals,
  inspectUserGlobalSkillRemoval,
  removeUserGlobalSkill,
  scanUserGlobalSkillInventory,
  type UserGlobalSkillFileSystem,
  type UserGlobalSkillInventoryOptions,
} from "../src/user-global-skill-inventory.js";
import type { ProjectSkillSelection } from "../src/project-manifest.js";

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-depot-global-inventory-"));
}

async function makeSkill(home: string, root: ".agents" | ".claude", name: string, contents = `---\nname: ${name}\ndescription: Test skill\n---\n\nSkill body\n`): Promise<string> {
  const directory = path.join(home, root, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), contents);
  return directory;
}

function managedSelection(installationPath: string, sourcePath = "portable/demo"): ProjectSkillSelection {
  return {
    source: { kind: "builtin", id: "builtin:agent-depot" },
    path: sourcePath,
    version: { policy: "latest" },
    hosts: ["pi"],
    installation: { path: installationPath, adopted: false },
  };
}

async function scan(homeDirectory: string, managedInstallations: readonly ProjectSkillSelection[] = []) {
  const options: UserGlobalSkillInventoryOptions = { homeDirectory, managedInstallations };
  return scanUserGlobalSkillInventory(options);
}

test("scans only immediate real Skill directories and classifies persisted managed paths", async () => {
  const home = await makeHome();
  try {
    await makeSkill(home, ".agents", "managed");
    await makeSkill(home, ".agents", "unmanaged");
    await makeSkill(home, ".agents", "nested-parent");
    await mkdir(path.join(home, ".agents", "skills", "nested-parent", "child"));
    await writeFile(path.join(home, ".agents", "skills", "nested-parent", "child", "SKILL.md"), "nested\n");
    await writeFile(path.join(home, ".agents", "skills", "not-a-skill.txt"), "no\n");

    const inventory = await scan(home, [managedSelection(".agents/skills/managed")]);
    assert.deepEqual(inventory.managed.map((entry) => entry.name), ["managed"]);
    assert.deepEqual(inventory.unmanaged.map((entry) => entry.name), ["nested-parent", "unmanaged"]);
    assert.equal(inventory.entries.some((entry) => entry.name === "child"), false);
    assert.equal(inventory.entries.some((entry) => entry.name === "not-a-skill.txt"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("deduplicates a managed Claude exposure without hiding a separate real duplicate", async (t) => {
  const home = await makeHome();
  try {
    const canonical = await makeSkill(home, ".agents", "demo");
    await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
    try {
      await symlink(path.relative(path.join(home, ".claude", "skills"), canonical), path.join(home, ".claude", "skills", "demo"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await makeSkill(home, ".claude", "duplicate");

    const inventory = await scan(home, [managedSelection(".agents/skills/demo")]);
    assert.deepEqual(inventory.managed.map((entry) => entry.name), ["demo"]);
    assert.deepEqual(inventory.unmanaged.map((entry) => entry.name), ["duplicate"]);
    assert.deepEqual(inventory.exposures.map((entry) => [entry.name, entry.path, entry.target]), [
      ["demo", path.join(home, ".claude", "skills", "demo"), canonical],
    ]);
    assert.deepEqual(inventory.skipped, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function linkOrSkip(t: { skip: (message: string) => void }, target: string, linkPath: string): Promise<boolean> {
  await mkdir(path.dirname(linkPath), { recursive: true });
  try {
    await symlink(target, linkPath, "dir");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("symbolic links are unavailable in this environment");
      return false;
    }
    throw error;
  }
}

test("treats a Claude symlink to the same-name canonical directory of a listed unmanaged Skill as an exposure", async (t) => {
  const home = await makeHome();
  try {
    const canonical = await makeSkill(home, ".agents", "stray");
    if (!(await linkOrSkip(t, "../../.agents/skills/stray", path.join(home, ".claude", "skills", "stray")))) return;

    const inventory = await scan(home);
    assert.deepEqual(inventory.unmanaged.map((entry) => entry.path), [canonical]);
    assert.deepEqual(inventory.exposures.map((entry) => entry.name), ["stray"]);
    assert.deepEqual(inventory.skipped, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("still reports Claude symlinks that are not a same-name exposure of a listed canonical Skill", async (t) => {
  const home = await makeHome();
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-global-inventory-outside-"));
  try {
    await makeSkill(home, ".agents", "alpha");
    await mkdir(path.join(home, ".agents", "skills", "empty-dir"), { recursive: true });
    const claudeRoot = path.join(home, ".claude", "skills");
    if (!(await linkOrSkip(t, "../../.agents/skills/alpha", path.join(claudeRoot, "renamed")))) return;
    await linkOrSkip(t, "../../.agents/skills/missing", path.join(claudeRoot, "dangling"));
    await linkOrSkip(t, "../../.agents/skills/empty-dir", path.join(claudeRoot, "empty-dir"));
    await linkOrSkip(t, (await makeSkill(outside, ".agents", "elsewhere")), path.join(claudeRoot, "elsewhere"));

    const inventory = await scan(home, [managedSelection(".agents/skills/alpha")]);
    assert.deepEqual(inventory.exposures, []);
    assert.deepEqual(
      inventory.skipped.map((entry) => [entry.name, entry.reason]),
      [["dangling", "unsafe-entry"], ["elsewhere", "unsafe-entry"], ["empty-dir", "unsafe-entry"], ["renamed", "unsafe-entry"]],
    );
    assert.equal(inventory.entries.some((entry) => entry.root === "claude"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("preserves noncanonical adoption and path normalization while exposing a same-name real copy", async () => {
  const home = await makeHome();
  try {
    await makeSkill(home, ".claude", "adopted");
    await makeSkill(home, ".agents", "adopted");
    const inventory = await scan(home, [managedSelection(".claude/skills/./adopted")]);

    assert.deepEqual(inventory.managed.map((entry) => entry.path), [path.join(home, ".claude", "skills", "adopted")]);
    assert.deepEqual(inventory.unmanaged.map((entry) => entry.path), [path.join(home, ".agents", "skills", "adopted")]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("protects canonical and Claude alias paths during unmanaged removal", async () => {
  const home = await makeHome();
  try {
    const canonical = await makeSkill(home, ".agents", "demo");
    const claudeAlias = await makeSkill(home, ".claude", "demo");
    await assert.rejects(
      inspectUserGlobalSkillRemoval(claudeAlias, {
        homeDirectory: home,
        managedInstallations: [managedSelection(".agents/skills/demo")],
      }),
      /managed or aliases a managed installation/,
    );

    const canonicalInspection = await inspectUserGlobalSkillRemoval(canonical, { homeDirectory: home, managedInstallations: [] });
    const claudeInspection = await inspectUserGlobalSkillRemoval(claudeAlias, { homeDirectory: home, managedInstallations: [] });
    assert.throws(
      () => assertNoOverlappingUserGlobalSkillRemovals([canonicalInspection, claudeInspection]),
      /canonical\/Claude aliases overlap/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("matches managed paths and transient exclusions with Windows-like case differences", async () => {
  const home = await makeHome();
  try {
    await makeSkill(home, ".agents", "managed");
    await makeSkill(home, ".agents", ".AGENT-DEPOT-BACKUP-COPY");
    const inventory = await scan(home, [managedSelection(".AGENTS\\SKILLS\\MANAGED")]);
    assert.deepEqual(inventory.managed.map((entry) => entry.name), ["managed"]);
    assert.deepEqual(inventory.unmanaged, []);
    assert.equal(inventory.skipped.some((entry) => entry.reason === "excluded-transient"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reports unsafe links and malformed Skill files instead of making them removal candidates", async (t) => {
  const home = await makeHome();
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-global-inventory-outside-"));
  try {
    await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await makeSkill(outside, ".agents", "outside");
    try {
      await symlink(path.join(outside, ".agents", "skills", "outside"), path.join(home, ".agents", "skills", "unsafe"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await mkdir(path.join(home, ".agents", "skills", "linked-skill"), { recursive: true });
    await symlink("missing-skill.md", path.join(home, ".agents", "skills", "linked-skill", "SKILL.md"));
    const nestedLink = await makeSkill(home, ".agents", "nested-link");
    await symlink(path.join(outside, ".agents", "skills", "outside"), path.join(nestedLink, "references-link"), "dir");
    const malformed = await makeSkill(home, ".agents", "malformed", "not frontmatter\n");

    const inventory = await scan(home);
    assert.equal(inventory.entries.length, 0);
    assert.deepEqual(
      inventory.skipped.map((entry) => [entry.name, entry.reason]),
      [["linked-skill", "unsafe-skill-file"], ["malformed", "unsafe-skill-file"], ["nested-link", "unsafe-entry"], ["unsafe", "unsafe-entry"]],
    );
    assert.match(inventory.skipped.find((entry) => entry.path === malformed)?.detail ?? "", /valid top-level name and description/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("excludes Agent Depot backup and staging names without traversing them", async () => {
  const home = await makeHome();
  try {
    for (const name of [
      ".agent-depot-backup-copy",
      ".agent-depot-update-copy",
      ".agent-depot-overwrite-copy",
      ".agent-depot-staging-copy",
      ".agent-depot-temp-copy",
      "ordinary.tmp",
      ".AGENT-DEPOT-BACKUP-UPPER",
      "ORDINARY.TMP",
    ]) {
      await makeSkill(home, ".agents", name);
    }
    await makeSkill(home, ".agents", "keep-me");

    const inventory = await scan(home);
    assert.deepEqual(inventory.unmanaged.map((entry) => entry.name), ["keep-me"]);
    assert.equal(inventory.skipped.filter((entry) => entry.reason === "excluded-transient").length, 8);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rechecks unmanaged content and identity before permanent deletion", async () => {
  const home = await makeHome();
  try {
    const skill = await makeSkill(home, ".agents", "raced", "---\nname: raced\ndescription: Before\n---\n\nBefore\n");
    const inspection = await inspectUserGlobalSkillRemoval(skill, { homeDirectory: home, managedInstallations: [] });
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: raced\ndescription: After\n---\n\nAfter\n");
    await assert.rejects(
      removeUserGlobalSkill(inspection, { homeDirectory: home, managedInstallations: [] }),
      /changed before deletion/,
    );
    assert.equal(await readFile(path.join(skill, "SKILL.md"), "utf8"), "---\nname: raced\ndescription: After\n---\n\nAfter\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("moves an unmanaged tree to same-parent staging before deleting it", async () => {
  const home = await makeHome();
  try {
    const skill = await makeSkill(home, ".agents", "delete-me", "---\nname: delete-me\ndescription: Delete\n---\n\nDelete\n");
    await mkdir(path.join(skill, "references"));
    await writeFile(path.join(skill, "references", "guide.md"), "guide\n");
    const inspection = await inspectUserGlobalSkillRemoval(skill, { homeDirectory: home, managedInstallations: [] });
    await removeUserGlobalSkill(inspection, { homeDirectory: home, managedInstallations: [] });
    await assert.rejects(lstat(skill), { code: "ENOENT" });
    const siblings = await readdir(path.dirname(skill));
    assert.equal(siblings.some((name) => name.includes("agent-depot-unmanaged-stage")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restores the original path when staging deletion fails", async () => {
  const home = await makeHome();
  try {
    const skill = await makeSkill(home, ".agents", "stage-failure");
    const inspection = await inspectUserGlobalSkillRemoval(skill, { homeDirectory: home, managedInstallations: [] });
    const fileSystem: UserGlobalSkillFileSystem = {
      lstat,
      readdir: async (candidate) => readdir(candidate),
      readFile,
      rename: async () => { throw new Error("injected rename failure"); },
      rm,
    };
    await assert.rejects(
      removeUserGlobalSkill(inspection, { homeDirectory: home, managedInstallations: [], fileSystem }),
      /no path was changed/,
    );
    assert.equal((await lstat(skill)).isDirectory(), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restores a staged tree when permanent deletion fails and retains it when restoration is uncertain", async () => {
  const home = await makeHome();
  try {
    const skill = await makeSkill(home, ".agents", "delete-failure");
    const inspection = await inspectUserGlobalSkillRemoval(skill, { homeDirectory: home, managedInstallations: [] });
    let restoreAttempt = false;
    let staged = false;
    const fileSystem: UserGlobalSkillFileSystem = {
      lstat,
      readdir: async (candidate) => readdir(candidate),
      readFile,
      rename: async (oldPath, newPath) => {
        if (!staged) {
          staged = true;
          return rename(oldPath, newPath);
        }
        restoreAttempt = true;
        await rename(oldPath, newPath);
      },
      rm: async () => { throw new Error("injected delete failure"); },
    };
    await assert.rejects(
      removeUserGlobalSkill(inspection, { homeDirectory: home, managedInstallations: [], fileSystem }),
      /original was restored/,
    );
    assert.equal(restoreAttempt, true);
    assert.equal((await lstat(skill)).isDirectory(), true);

    const uncertainSkill = await makeSkill(home, ".agents", "uncertain-failure");
    const uncertainInspection = await inspectUserGlobalSkillRemoval(uncertainSkill, { homeDirectory: home, managedInstallations: [] });
    const uncertainFileSystem: UserGlobalSkillFileSystem = {
      lstat,
      readdir: async (candidate) => readdir(candidate),
      readFile,
      rename: async (oldPath, newPath) => {
        if (oldPath === uncertainSkill) return rename(oldPath, newPath);
        throw new Error("injected restoration failure");
      },
      rm: async () => { throw new Error("injected delete failure"); },
    };
    await assert.rejects(
      removeUserGlobalSkill(uncertainInspection, { homeDirectory: home, managedInstallations: [], fileSystem: uncertainFileSystem }),
      /status is uncertain.*staged path retained/,
    );
    assert.equal((await readdir(path.dirname(uncertainSkill))).some((name) => name.includes("agent-depot-unmanaged-stage")), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects a symlinked global root ancestor before scanning or removal", async (t) => {
  const home = await makeHome();
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-global-inventory-ancestor-outside-"));
  try {
    await makeSkill(outside, ".agents", "outside");
    try {
      await symlink(path.join(outside, ".agents"), path.join(home, ".agents"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const inventory = await scan(home);
    assert.equal(inventory.entries.some((entry) => entry.name === "outside"), false);
    assert.equal(inventory.skipped.some((entry) => entry.reason === "unsafe-root"), true);
    await assert.rejects(
      inspectUserGlobalSkillRemoval(path.join(home, ".agents", "skills", "outside"), { homeDirectory: home, managedInstallations: [] }),
      /global Skill ancestor/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reports a symlinked global root as unsafe and does not scan through it", async (t) => {
  const home = await makeHome();
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-global-inventory-root-outside-"));
  try {
    await makeSkill(outside, ".agents", "outside");
    await mkdir(path.join(home, ".agents"), { recursive: true });
    try {
      await symlink(path.join(outside, ".agents", "skills"), path.join(home, ".agents", "skills"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const inventory = await scan(home);
    assert.equal(inventory.entries.some((entry) => entry.name === "outside"), false);
    assert.equal(inventory.skipped.some((entry) => entry.reason === "unsafe-root"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
