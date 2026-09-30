import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import type { ProjectSkillSelection } from "../src/project-manifest.js";
import {
  inspectProjectSkillRemoval,
  inspectProjectSkillUpdate,
  removeProjectSkill,
  updateProjectSkillTransaction,
  type ProjectInstallationOptions,
} from "../src/project-installation.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";

// Project-scope installation paths come from a committed, hostile-capable
// manifest. Only the canonical layout is trusted; an adopted Skill at another
// location needs strict validation plus explicit confirmation of that path.

const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: demo skill\n---\n${body}\n`;
}

function tree(name: string, body: string): readonly SkillTreeFile[] {
  return [{ path: `portable/${name}/SKILL.md`, content: Buffer.from(skillMd(name, body)), executable: false }];
}

function selectionAt(installationPath: string, name = "demo"): ProjectSkillSelection {
  return {
    source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
    path: `portable/${name}`,
    version: { policy: "latest" },
    hosts: ["pi"],
    installation: {
      path: installationPath,
      adopted: true,
      resolvedVersion: oldVersion,
      baseline: skillTreeBaseline(tree(name, "old")),
    },
  };
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-depot-noncanonical-"));
}

async function writeSkill(root: string, relativeDirectory: string, name = "demo", body = "old"): Promise<string> {
  const directory = path.join(root, ...relativeDirectory.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), skillMd(name, body));
  return directory;
}

function optionsFor(root: string, extra: Partial<ProjectInstallationOptions> = {}): ProjectInstallationOptions {
  return { projectRoot: root, sourceAccess: { async readSkillTree() { return tree("demo", "new"); } }, ...extra };
}

function updateRequest(selection: ProjectSkillSelection) {
  return { selection, source: BUILT_IN_SOURCE, previewTree: tree("demo", "new"), resolvedVersion: newVersion };
}

async function content(directory: string): Promise<string> {
  return readFile(path.join(directory, "SKILL.md"), "utf8");
}

test("an adopted non-canonical project Skill can be updated and removed after confirming its exact path", async () => {
  const root = await makeRoot();
  try {
    const directory = await writeSkill(root, "tools/skills/demo");
    const selection = selectionAt("tools/skills/demo");
    const confirmed = optionsFor(root, { confirmedNonCanonicalPath: directory });

    const inspection = await inspectProjectSkillUpdate(selection, optionsFor(root));
    assert.equal(inspection.nonCanonicalPath, directory);

    const transaction = await updateProjectSkillTransaction(updateRequest(selection), confirmed);
    await transaction.commit();
    assert.match(await content(directory), /new/u);

    const removal = await inspectProjectSkillRemoval(selection, optionsFor(root));
    assert.equal(removal.nonCanonicalPath, directory);
    await removeProjectSkill(selection, removal, confirmed);
    await assert.rejects(readFile(path.join(directory, "SKILL.md")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-canonical project path without confirmation fails closed and changes nothing", async () => {
  const root = await makeRoot();
  try {
    const directory = await writeSkill(root, "tools/skills/demo");
    const selection = selectionAt("tools/skills/demo");
    const before = await content(directory);

    await assert.rejects(updateProjectSkillTransaction(updateRequest(selection), optionsFor(root)), /confirm/iu);
    const removal = await inspectProjectSkillRemoval(selection, optionsFor(root));
    await assert.rejects(removeProjectSkill(selection, removal, optionsFor(root)), /confirm/iu);
    // Confirming some other path never authorizes this one.
    await assert.rejects(
      removeProjectSkill(selection, removal, optionsFor(root, { confirmedNonCanonicalPath: path.join(root, "src", "demo") })),
      /confirm/iu,
    );
    assert.equal(await content(directory), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a hostile manifest aimed at a directory without a matching SKILL.md is rejected even when confirmed", async () => {
  const root = await makeRoot();
  try {
    const victim = path.join(root, "src", "demo");
    await mkdir(victim, { recursive: true });
    await writeFile(path.join(victim, "index.ts"), "export {};\n");
    const selection = selectionAt("src/demo");
    const confirmed = optionsFor(root, { confirmedNonCanonicalPath: victim });

    await assert.rejects(inspectProjectSkillUpdate(selection, confirmed), /SKILL\.md/u);
    await assert.rejects(inspectProjectSkillRemoval(selection, confirmed), /SKILL\.md/u);
    await assert.rejects(updateProjectSkillTransaction(updateRequest(selection), confirmed), /SKILL\.md/u);
    assert.equal(await readFile(path.join(victim, "index.ts"), "utf8"), "export {};\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe non-canonical targets are each rejected even with a valid SKILL.md and confirmation", async (t) => {
  const root = await makeRoot();
  const outside = await makeRoot();
  try {
    await writeSkill(root, ".git/hooks/demo");
    await writeSkill(root, "tools/demo/inner/demo");
    await writeSkill(root, "tools/demo");
    await writeSkill(root, "packages/other", "other");
    await writeSkill(root, "packages/renamed", "demo");
    await writeSkill(root, "packages/wrong-name/demo", "not-demo");
    await writeSkill(outside, "demo");
    const symlinkCreated = await symlink(outside, path.join(root, "linked"), "dir").then(() => true, () => false);
    // The root itself carries a valid Skill: a root-level path must never be accepted.
    await writeFile(path.join(root, "SKILL.md"), skillMd("demo", "old"));

    const cases: Array<{ label: string; installationPath: string; extra?: Partial<ProjectInstallationOptions> }> = [
      { label: ".git component", installationPath: ".git/hooks/demo" },
      { label: "project root", installationPath: "." },
      { label: "ancestor of another tracked installation", installationPath: "tools/demo", extra: { otherInstallationPaths: ["tools/demo/inner/demo"] } },
      { label: "basename mismatch", installationPath: "packages/other" },
      { label: "basename mismatch with matching frontmatter", installationPath: "packages/renamed" },
      { label: "SKILL.md name mismatch", installationPath: "packages/wrong-name/demo" },
      ...(symlinkCreated ? [{ label: "symlinked component", installationPath: "linked/demo" }] : []),
    ];
    for (const { label, installationPath, extra } of cases) {
      const selection = selectionAt(installationPath);
      const target = path.resolve(root, installationPath);
      const confirmed = optionsFor(root, { confirmedNonCanonicalPath: target, ...extra });
      await assert.rejects(inspectProjectSkillUpdate(selection, confirmed), (): boolean => true, `inspect update: ${label}`);
      await assert.rejects(inspectProjectSkillRemoval(selection, confirmed), (): boolean => true, `inspect removal: ${label}`);
      await assert.rejects(updateProjectSkillTransaction(updateRequest(selection), confirmed), (): boolean => true, `update: ${label}`);
    }
    if (!symlinkCreated) t.diagnostic("symbolic links unavailable; symlinked-component case skipped");
    assert.equal(await content(path.join(root, ".git", "hooks", "demo")), skillMd("demo", "old"));
    assert.equal(await content(path.join(root, "tools", "demo")), skillMd("demo", "old"));
    assert.equal(await content(path.join(outside, "demo")), skillMd("demo", "old"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("canonical project paths keep working without any confirmation", async () => {
  const root = await makeRoot();
  try {
    for (const canonical of [".agents/skills/demo", ".claude/skills/demo"]) {
      const directory = await writeSkill(root, canonical);
      const selection = selectionAt(canonical);
      assert.equal((await inspectProjectSkillUpdate(selection, optionsFor(root))).nonCanonicalPath, undefined);
      const transaction = await updateProjectSkillTransaction(updateRequest(selection), optionsFor(root));
      await transaction.commit();
      assert.match(await content(directory), /new/u);
      const removal = await inspectProjectSkillRemoval(selection, optionsFor(root));
      assert.equal(removal.nonCanonicalPath, undefined);
      await removeProjectSkill(selection, removal, optionsFor(root));
      await assert.rejects(readFile(path.join(directory, "SKILL.md")), /ENOENT/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-global records keep any in-home installation path because the state file is trusted", async () => {
  const home = await makeRoot();
  try {
    const directory = await writeSkill(home, ".pi/agent/skills/demo", "demo", "old");
    // A trusted global record may legitimately point at an adopted location and
    // even hold a SKILL.md without the frontmatter Agent Depot would check.
    await writeFile(path.join(directory, "SKILL.md"), "plain adopted content");
    const selection: ProjectSkillSelection = {
      ...selectionAt(".pi/agent/skills/demo"),
      installation: { path: ".pi/agent/skills/demo", adopted: true, resolvedVersion: oldVersion, baseline: skillTreeBaseline([
        { path: "portable/demo/SKILL.md", content: Buffer.from("plain adopted content"), executable: false },
      ]) },
    };
    const options = optionsFor(home, { installationTrust: "user-global-state" });
    const removal = await inspectProjectSkillRemoval(selection, options);
    assert.equal(removal.nonCanonicalPath, undefined);
    const transaction = await updateProjectSkillTransaction(updateRequest(selection), options);
    await transaction.commit();
    await removeProjectSkill(selection, await inspectProjectSkillRemoval(selection, options), options);
    await assert.rejects(readFile(path.join(directory, "SKILL.md")), /ENOENT/u);
    // Still confined to the home directory.
    await assert.rejects(inspectProjectSkillRemoval(selectionAt("../outside/demo"), options), /escapes/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("update apply previews a non-canonical project path and requires --yes to change it", async () => {
  const root = await makeRoot();
  try {
    const directory = await writeSkill(root, "tools/skills/demo");
    await writeFile(path.join(root, "agent-depot.json"), JSON.stringify({ version: 1, skills: [selectionAt("tools/skills/demo")] }), "utf8");
    const output: string[] = [];
    const errors: string[] = [];
    const dependencies = {
      operations: {} as SourceOperations,
      projectRoot: root,
      sourceAccess: {
        async readSkillTree() { return tree("demo", "new"); },
        async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; },
      },
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(["update", "apply", "--scope", "project", "--all"], dependencies), 1);
    assert.match(output.join("\n"), /non-canonical/iu);
    assert.ok(output.join("\n").includes(directory), "the preview must show the exact path");
    assert.match(await content(directory), /old/u);

    output.length = 0;
    assert.equal(await runCli(["update", "apply", "--scope", "project", "--all", "--yes"], dependencies), 0);
    assert.match(await content(directory), /new/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
