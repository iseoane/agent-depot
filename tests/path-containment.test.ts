import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProjectSkillSelection } from "../src/project-manifest.js";
import {
  inspectProjectSkillRemoval,
  inspectProjectSkillUpdate,
  installProjectSkill,
  removeProjectSkill,
  updateProjectSkillTransaction,
  type ProjectSkillTreeAccess,
} from "../src/project-installation.js";
import type { SkillTreeFile } from "../src/skill-discovery.js";
import type { Source } from "../src/sources.js";
import { inspectUserGlobalSkillRemoval } from "../src/user-global-skill-inventory.js";

// Adversarial regression tests for the path-containment triage: a hostile Source
// or manifest must never make a write/delete flow leave its target directory.

const source: Source = { id: "builtin:agent-depot", kind: "builtin", name: "Agent Depot", packageOwned: true };
const digest = { algorithm: "sha256", digest: "a".repeat(64) } as const;

function selectionFor(installationPath: string, skillPath = "portable/demo"): ProjectSkillSelection {
  return {
    source: { kind: "builtin", id: "builtin:agent-depot" },
    path: skillPath,
    version: { policy: "fixed", version: "a".repeat(40) },
    hosts: ["pi"],
    installation: { path: installationPath, adopted: false, baseline: digest },
  };
}

function access(files: readonly SkillTreeFile[]): ProjectSkillTreeAccess {
  return { async readSkillTree() { return files; } };
}

const goodTree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Buffer.from("skill"), executable: false },
];

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-depot-containment-"));
}

async function snapshot(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.map((entry) => path.join(entry.parentPath, entry.name)).sort().join("\n");
}

async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, "dir");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  }
}

test("install rejects hostile Skill names and tree paths without writing anything", async () => {
  const hostileSelections = ["..", "portable/..", "portable/."];
  for (const skillPath of hostileSelections) {
    const projectRoot = await makeDir();
    try {
      const before = await snapshot(projectRoot);
      await assert.rejects(installProjectSkill({
        selection: { ...selectionFor(".agents/skills/x", skillPath), installation: undefined },
        source,
        portableV1: true,
      }, { projectRoot, sourceAccess: access([{ path: `${skillPath}/SKILL.md`, content: Buffer.from("x"), executable: false }]) }));
      assert.equal(await snapshot(projectRoot), before, `${skillPath} must not change the project`);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }

  const hostileFiles = [
    "portable/demo//etc/passwd",
    "portable/demo/../../escape.txt",
    "portable/demo/a/../../../escape.txt",
    "portable/demo/a\\..\\escape.txt",
    "portable/demo/./escape.txt",
    "portable/demo/",
    "portable/demo/x/",
    "portable/other/SKILL.md",
  ];
  for (const filePath of hostileFiles) {
    const projectRoot = await makeDir();
    try {
      const before = await snapshot(projectRoot);
      await assert.rejects(installProjectSkill({
        selection: { ...selectionFor(".agents/skills/demo"), installation: undefined },
        source,
        portableV1: true,
      }, { projectRoot, sourceAccess: access([...goodTree, { path: filePath, content: Buffer.from("x"), executable: false }]) }), (): boolean => true, filePath);
      assert.equal(await snapshot(projectRoot), before, `${filePath} must not change the project`);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

test("a hostile manifest installation path cannot aim removal or update at arbitrary project directories", async () => {
  const hostilePaths = [
    "src/demo",
    "docs",
    ".git/hooks/demo",
    ".agents",
    ".agents/skills",
    ".agents/skills/demo/nested",
    ".claude/skills/demo/nested",
    ".agents/other/demo",
    ".agents/skills/../../src/demo",
    "../outside/demo",
    "/etc/demo",
  ];
  for (const installationPath of hostilePaths) {
    const projectRoot = await makeDir();
    try {
      const victims = ["src/demo", "docs", ".git/hooks/demo", ".agents/skills/demo/nested", ".claude/skills/demo/nested", ".agents/other/demo"];
      for (const victim of victims) {
        await mkdir(path.join(projectRoot, victim), { recursive: true });
        await writeFile(path.join(projectRoot, victim, "SKILL.md"), "victim");
      }
      const before = await snapshot(projectRoot);
      const selection = selectionFor(installationPath);
      const options = { projectRoot, sourceAccess: access(goodTree) };

      await assert.rejects(inspectProjectSkillRemoval(selection, options), (): boolean => true, `remove ${installationPath}`);
      await assert.rejects(inspectProjectSkillUpdate(selection, options), (): boolean => true, `inspect update ${installationPath}`);
      await assert.rejects(
        updateProjectSkillTransaction({ selection, source, confirmOverwrite: true, previewTree: goodTree }, options),
        (): boolean => true,
        `update ${installationPath}`,
      );
      await assert.rejects(
        removeProjectSkill(selection, { skillName: "demo", paths: [path.join(projectRoot, installationPath)], digest: "x", adopted: false, modified: true }, options),
        (): boolean => true,
        `removeProjectSkill ${installationPath}`,
      );
      assert.equal(await snapshot(projectRoot), before, `${installationPath} must leave the project untouched`);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

test("symlinked tracked Skill directories are never followed by removal or update", async (t) => {
  const projectRoot = await makeDir();
  const outside = await makeDir();
  try {
    await mkdir(path.join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(path.join(outside, "SKILL.md"), "outside");
    if (!await trySymlink(outside, path.join(projectRoot, ".agents", "skills", "demo"))) {
      t.skip("symbolic links are unavailable in this environment");
      return;
    }
    const selection = selectionFor(".agents/skills/demo");
    const options = { projectRoot, sourceAccess: access(goodTree) };
    await assert.rejects(inspectProjectSkillRemoval(selection, options), /symbolic|real directory/i);
    await assert.rejects(inspectProjectSkillUpdate(selection, options), /symbolic|real directory/i);
    await assert.rejects(
      updateProjectSkillTransaction({ selection, source, confirmOverwrite: true, previewTree: goodTree }, options),
      /symbolic|real directory/i,
    );
    assert.equal(await snapshot(outside), path.join(outside, "SKILL.md"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlinked project skills root cannot redirect removal outside the project", async (t) => {
  const projectRoot = await makeDir();
  const outside = await makeDir();
  try {
    await mkdir(path.join(outside, "demo"), { recursive: true });
    await writeFile(path.join(outside, "demo", "SKILL.md"), "outside");
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    if (!await trySymlink(outside, path.join(projectRoot, ".agents", "skills"))) {
      t.skip("symbolic links are unavailable in this environment");
      return;
    }
    const before = await snapshot(outside);
    await assert.rejects(inspectProjectSkillRemoval(selectionFor(".agents/skills/demo"), { projectRoot, sourceAccess: access(goodTree) }), /symbolic/i);
    assert.equal(await snapshot(outside), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("unmanaged user-global removal rejects hostile explicit paths and symlinked Skill directories", async (t) => {
  const home = await makeDir();
  const outside = await makeDir();
  try {
    await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await mkdir(path.join(outside, "victim"), { recursive: true });
    await writeFile(path.join(outside, "victim", "SKILL.md"), "---\nname: victim\ndescription: d\n---\n");
    const options = { homeDirectory: home, managedInstallations: [] };
    const skills = path.join(home, ".agents", "skills");
    const hostile = [
      "victim",
      path.join(skills, "..", "..", "..", "etc"),
      path.join(skills, "a", "b"),
      skills,
      home,
      path.join(outside, "victim"),
      `${skills}/`,
    ];
    for (const candidate of hostile) {
      await assert.rejects(inspectUserGlobalSkillRemoval(candidate, options), (): boolean => true, candidate);
    }
    if (await trySymlink(path.join(outside, "victim"), path.join(skills, "linked"))) {
      await assert.rejects(inspectUserGlobalSkillRemoval(path.join(skills, "linked"), options), /real directory/i);
    } else {
      t.diagnostic("symbolic links unavailable; symlinked-directory case skipped");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
