import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { installProjectSkill, type ProjectInstallationFileSystem } from "../src/project-installation.js";
import { ProjectManifestStore, type ProjectSkillSelection, type SourceInstallationMethod } from "../src/project-manifest.js";
import { applySkillUpdate, applyUpdateBatch, previewSkillUpdate } from "../src/skill-update.js";
import { assessUpdateBatch } from "../src/update-batch.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceInstallationContext, type SourceOperations } from "../src/sources.js";
import type { SkillTreeFile } from "../src/skill-discovery.js";

const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };

function tree(name: string, content: string): readonly SkillTreeFile[] {
  return [{ path: `portable/${name}/SKILL.md`, content: Buffer.from(content), executable: false }];
}

function baseSelection(name: string): ProjectSkillSelection {
  return {
    source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
    path: `portable/${name}`,
    version: { policy: "latest" },
    hosts: ["pi"],
  };
}

async function setupSkill(
  root: string,
  name: string,
  content: string,
  methods?: ProjectSkillSelection["methods"],
): Promise<ProjectSkillSelection> {
  const selection = { ...baseSelection(name), ...(methods === undefined ? {} : { methods }) };
  const sourceFiles = tree(name, content);
  const result = await installProjectSkill({
    selection,
    source: BUILT_IN_SOURCE,
    previewTree: sourceFiles,
    portableV1: true,
    resolvedVersion: oldVersion,
  }, {
    projectRoot: root,
    sourceAccess: { async readSkillTree() { return sourceFiles; } },
  });
  return {
    ...selection,
    installation: {
      path: path.relative(root, result.canonicalPath).split(path.sep).join("/"),
      adopted: result.adopted,
      resolvedVersion: oldVersion,
      baseline: result.baseline,
    },
  };
}

test("previews an immutable update and requires explicit overwrite confirmation for local edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const selection = await setupSkill(root, "demo", "old");
    const target = path.join(root, ".agents", "skills", "demo", "SKILL.md");
    await writeFile(target, "locally edited");
    const item = (await assessUpdateBatch([selection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: {
        async readSkillTreeSnapshot() {
          return { files: tree("demo", "new"), resolvedVersion: newVersion };
        },
      },
    })).items[0]!;

    const plan = await previewSkillUpdate(item, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
    });
    assert.equal(plan.overwriteRequired, true);
    await assert.rejects(
      applySkillUpdate(item, {
        projectRoot: root,
        scope: "project",
        sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
        confirmation: {},
      }),
      /explicit overwrite confirmation/i,
    );
    assert.equal(await readFile(target, "utf8"), "locally edited");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rolls back managed files when an explicitly confirmed external method fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const selection = await setupSkill(root, "demo", "old", { update: { kind: "command", argv: ["pnpm", "update"] } });
    const store = new ProjectManifestStore(path.join(root, "agent-depot.json"));
    await store.save({ version: 1, skills: [selection] });
    const item = (await assessUpdateBatch([selection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: { async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; } },
    })).items[0]!;
    let executed = false;
    const operations = {
      async executeInstallationMethod() { executed = true; throw new Error("method failed"); },
    } as unknown as SourceOperations;

    const plan = await previewSkillUpdate(item, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      sourceOperations: operations,
    });
    assert.deepEqual(plan.methodPreview?.argv, ["pnpm", "update"]);
    assert.equal(plan.methodPreview?.target, path.join(root, ".agents", "skills", "demo"));
    assert.match(plan.methodPreview?.warning ?? "", /cannot verify or roll back/i);
    await assert.rejects(applySkillUpdate(item, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      sourceOperations: operations,
      confirmation: { externalMethod: true },
    }), /method failed/);
    assert.equal(executed, true);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
    assert.deepEqual((await store.load()).skills[0]?.installation?.resolvedVersion, oldVersion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores persisted state when deleting the filesystem backup fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const selection = await setupSkill(root, "demo", "old");
    const store = new ProjectManifestStore(path.join(root, "agent-depot.json"));
    await store.save({ version: 1, skills: [selection] });
    const item = (await assessUpdateBatch([selection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: { async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; } },
    })).items[0]!;
    const fileSystem: ProjectInstallationFileSystem = {
      lstat,
      readdir: async (candidate) => readdir(candidate),
      readFile: async (candidate) => readFile(candidate),
      mkdir: async (candidate) => { await mkdir(candidate); },
      writeFile: async (candidate, content) => { await writeFile(candidate, content, { flag: "wx" }); },
      chmod,
      symlink: async (target, candidate, type) => { await symlink(target, candidate, type); },
      readlink,
      rename,
      rm: async (candidate) => {
        if (candidate.includes(".agent-depot-backup-")) throw new Error("backup commit failed");
        await rm(candidate, { recursive: true, force: true });
      },
      rmdir,
    };

    await assert.rejects(applySkillUpdate(item, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      projectManifestStore: store,
      installationFileSystem: fileSystem,
    }), /backup commit failed/);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
    assert.deepEqual((await store.load()).skills[0]?.installation?.resolvedVersion, oldVersion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds update bytes, method argv, and method context to the displayed candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const mutableSelection = await setupSkill(root, "demo", "old", { update: { kind: "command", argv: ["pnpm", "update"] } });
    const store = new ProjectManifestStore(path.join(root, "agent-depot.json"));
    await store.save({ version: 1, skills: [mutableSelection] });
    const item = (await assessUpdateBatch([mutableSelection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: { async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; } },
    })).items[0]!;
    const mutableInput = mutableSelection as unknown as { path: string; methods: { update: { argv: string[] } } };
    mutableInput.path = "mutated-after-assessment";
    mutableInput.methods.update.argv[0] = "tampered";
    let methodArgv: readonly string[] | undefined;
    let methodSkillPath: string | undefined;

    await applySkillUpdate(item, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      projectManifestStore: store,
      sourceOperations: {
        async executeInstallationMethod(method, context) {
          methodArgv = method.argv;
          methodSkillPath = context.skillPath;
        },
      },
      confirmation: { externalMethod: true },
      confirm: (plan) => {
        plan.snapshot.files[0]!.content[0] = "X".charCodeAt(0);
        return { externalMethod: true };
      },
    });

    assert.deepEqual(methodArgv, ["pnpm", "update"]);
    assert.equal(methodSkillPath, "portable/demo");
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an external method cwd before replacing the managed tree", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-update-outside-"));
  try {
    try {
      await symlink(outside, path.join(root, "tools"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const selection = await setupSkill(root, "demo", "old", { update: { kind: "command", argv: ["pnpm", "update"], cwd: "tools" } });
    const store = new ProjectManifestStore(path.join(root, "agent-depot.json"));
    await store.save({ version: 1, skills: [selection] });
    const item = (await assessUpdateBatch([selection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: { async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; } },
    })).items[0]!;
    let executed = false;

    await assert.rejects(applySkillUpdate(item, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      projectManifestStore: store,
      executeMethod: async () => { executed = true; },
      confirmation: { externalMethod: true },
    }), /escapes the project root/);
    assert.equal(executed, false);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("executes a direct user-global update and persists new evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const selection = await setupSkill(root, "demo", "old");
    const operations = createSourceOperations({ statePath: path.join(root, "state", "sources.json") });
    await operations.addUserGlobalInstallation!(selection);
    const item = (await assessUpdateBatch([selection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: { async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; } },
    })).items[0]!;

    const result = await applySkillUpdate(item, {
      projectRoot: root,
      scope: "user-global",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      sourceOperations: operations,
    });

    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "new");
    const persisted = (await operations.listUserGlobalInstallations!())[0]!;
    assert.deepEqual(persisted.installation?.resolvedVersion, newVersion);
    assert.deepEqual(persisted.installation?.baseline, result.installation.baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rolls back a direct user-global update when persistence fails after writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const selection = await setupSkill(root, "demo", "old");
    const operations = createSourceOperations({ statePath: path.join(root, "state", "sources.json") });
    await operations.addUserGlobalInstallation!(selection);
    const item = (await assessUpdateBatch([selection], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: { async readSkillTreeSnapshot() { return { files: tree("demo", "new"), resolvedVersion: newVersion }; } },
    })).items[0]!;
    let updateCalls = 0;
    const failingOperations = {
      ...operations,
      async updateUserGlobalInstallation(updatedSelection: ProjectSkillSelection) {
        updateCalls += 1;
        await operations.updateUserGlobalInstallation!(updatedSelection);
        if (updateCalls === 1) throw new Error("persist failed after writing");
      },
    };

    await assert.rejects(applySkillUpdate(item, {
      projectRoot: root,
      scope: "user-global",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      sourceOperations: failingOperations,
    }), /persist failed after writing/);

    assert.equal(updateCalls, 2);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
    const persisted = (await operations.listUserGlobalInstallations!())[0]!;
    assert.deepEqual(persisted.installation?.resolvedVersion, oldVersion);
    assert.deepEqual(persisted.installation?.baseline, selection.installation?.baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continues a batch after one independent update fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-update-"));
  try {
    const first = await setupSkill(root, "first", "old-first", { update: { kind: "command", argv: ["pnpm", "update-first"] } });
    const second = await setupSkill(root, "second", "old-second");
    const store = new ProjectManifestStore(path.join(root, "agent-depot.json"));
    await store.save({ version: 1, skills: [first, second] });
    const assessment = await assessUpdateBatch([first, second], {
      resolveSource: async () => BUILT_IN_SOURCE,
      sourceAccess: {
        async readSkillTreeSnapshot(_source, skillPath) {
          return { files: tree(skillPath.endsWith("first") ? "first" : "second", "new"), resolvedVersion: newVersion };
        },
      },
    });
    const result = await applyUpdateBatch(assessment, {
      projectRoot: root,
      scope: "project",
      sourceAccess: { async readSkillTree() { throw new Error("must use immutable preview"); } },
      sourceOperations: {
        async executeInstallationMethod(_method: SourceInstallationMethod, context: SourceInstallationContext) {
          if (context.skillPath.endsWith("first")) throw new Error("first failed");
        },
      } as unknown as SourceOperations,
      confirmation: { externalMethod: true },
    });

    assert.equal(result.updated.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "first", "SKILL.md"), "utf8"), "old-first");
    assert.equal(await readFile(path.join(root, ".agents", "skills", "second", "SKILL.md"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
