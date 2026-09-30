import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProjectSkillSelection } from "../src/project-manifest.js";
import {
  inspectProjectSkillInstallation,
  inspectProjectSkillUpdate,
  installProjectSkill,
  installProjectSkillTransaction,
  type ProjectInstallationFileSystem,
  type ProjectSkillTreeAccess,
} from "../src/project-installation.js";
import type { SkillTreeFile } from "../src/skill-discovery.js";
import type { Source } from "../src/sources.js";

const source: Source = {
  id: "builtin:agent-depot",
  kind: "builtin",
  name: "Agent Depot",
  packageOwned: true,
};

const selection: ProjectSkillSelection = {
  source: { kind: "builtin", id: "builtin:agent-depot" },
  path: "portable/demo",
  version: { policy: "fixed", version: "a".repeat(40) },
  hosts: ["pi", "claude", "codex", "opencode"],
};

const tree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Uint8Array.from([0x53, 0x4b, 0x49, 0x4c, 0x4c]), executable: false },
  { path: "portable/demo/assets/data.bin", content: Uint8Array.from([0x00, 0xff, 0x80]), executable: false },
  { path: "portable/demo/scripts/run.sh", content: Uint8Array.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68]), executable: true },
];

function accessFor(files: readonly SkillTreeFile[] = tree): ProjectSkillTreeAccess {
  return {
    async readSkillTree(requestedSource, requestedPath) {
      assert.equal(requestedSource.id, source.id);
      assert.equal(requestedPath, selection.path);
      return files;
    },
  };
}

async function makeProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-depot-project-install-")).catch((error: unknown) => {
    throw error;
  });
}

test("installs a full project Skill tree at the canonical path and exposes Claude by symlink", async (t) => {
  const projectRoot = await makeProject();
  try {
    try {
      await symlink(path.join(projectRoot, "missing-target"), path.join(projectRoot, "link-check"), "dir");
      await rm(path.join(projectRoot, "link-check"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    const result = await installProjectSkill({
      selection,
      source,
      portableV1: true,
      resolvedVersion: { kind: "builtin-package", version: "0.1.0" },
    }, {
      projectRoot,
      sourceAccess: accessFor(),
    });
    const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
    const claudePath = path.join(projectRoot, ".claude", "skills", "demo");

    assert.equal(result.canonicalPath, canonicalPath);
    assert.equal(result.claudePath, claudePath);
    assert.deepEqual(result.files, ["SKILL.md", "assets/data.bin", "scripts/run.sh"]);
    assert.deepEqual([...result.hosts], ["pi", "claude", "codex", "opencode"]);
    assert.deepEqual(result.resolvedVersion, { kind: "builtin-package", version: "0.1.0" });
    assert.equal(result.baseline.algorithm, "sha256");
    assert.match(result.baseline.digest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(await readFile(path.join(canonicalPath, "assets", "data.bin")), Buffer.from([0x00, 0xff, 0x80]));
    assert.equal((await lstat(path.join(canonicalPath, "SKILL.md"))).mode & 0o777, 0o644);
    assert.equal((await lstat(path.join(canonicalPath, "scripts", "run.sh"))).mode & 0o111, 0o111);
    assert.equal(await readlink(claudePath), path.relative(path.dirname(claudePath), canonicalPath));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("preserves skill-relative agents support files during install and adoption", async () => {
  const projectRoot = await makeProject();
  const supportTree: readonly SkillTreeFile[] = [
    ...tree,
    { path: "portable/demo/agents/openai.yaml", content: Buffer.from("model = gpt-4.1\n"), executable: false },
  ];
  try {
    const first = await installProjectSkill({
      selection: { ...selection, hosts: ["pi"] },
      source,
      portableV1: true,
      previewTree: supportTree,
    }, { projectRoot, sourceAccess: accessFor(supportTree) });
    const supportPath = path.join(first.canonicalPath, "agents", "openai.yaml");
    assert.equal(await readFile(supportPath, "utf8"), "model = gpt-4.1\n");

    const adopted = await installProjectSkill({
      selection: { ...selection, hosts: ["pi"] },
      source,
      portableV1: true,
      previewTree: supportTree,
    }, { projectRoot, sourceAccess: accessFor(supportTree) });
    assert.equal(adopted.adopted, true);
    assert.deepEqual(adopted.files, ["SKILL.md", "assets/data.bin", "scripts/run.sh", "agents/openai.yaml"]);
    assert.equal(await readFile(supportPath, "utf8"), "model = gpt-4.1\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("installs the exact preview tree without rereading a mutable Source", async () => {
  const projectRoot = await makeProject();
  let reads = 0;
  const mutableTree = [...tree];
  try {
    const transaction = await installProjectSkillTransaction({
      selection,
      source,
      portableV1: true,
      previewTree: mutableTree,
    }, {
      projectRoot,
      sourceAccess: {
        async readSkillTree() {
          reads += 1;
          return [{ ...tree[0], content: Uint8Array.from([0x6e, 0x6f, 0x74, 0x2d, 0x75, 0x73, 0x65, 0x64]) }];
        },
      },
    });
    mutableTree[0] = { ...mutableTree[0], content: Uint8Array.from([0x63, 0x68, 0x61, 0x6e, 0x67, 0x65, 0x64]) };
    assert.equal(reads, 0);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "SKILL");
    await transaction.rollback();
    await assert.rejects(lstat(path.join(projectRoot, ".agents", "skills", "demo")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("requires explicit compatibility evidence instead of claiming every Host by default", async () => {
  const projectRoot = await makeProject();
  let read = false;
  try {
    await assert.rejects(
      installProjectSkill({ selection, source }, {
        projectRoot,
        sourceAccess: {
          async readSkillTree() {
            read = true;
            return tree;
          },
        },
      }),
      /no compatibility evidence.*portable V1 baseline/i,
    );
    assert.equal(read, false);
    await assert.rejects(lstat(path.join(projectRoot, ".agents")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects host-specific incompatibility metadata even with the portable V1 baseline", async () => {
  const projectRoot = await makeProject();
  let read = false;
  try {
    await assert.rejects(
      installProjectSkill({
        selection: { ...selection, hosts: ["claude"] },
        source,
        portableV1: true,
        compatibility: { claude: "Claude requires a native extension" },
      }, {
        projectRoot,
        sourceAccess: {
          async readSkillTree() {
            read = true;
            return tree;
          },
        },
      }),
      /incompatible.*claude.*native extension/i,
    );
    assert.equal(read, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects an incompatible selected Host before reading or changing the project", async () => {
  const projectRoot = await makeProject();
  let read = false;
  try {
    await assert.rejects(
      installProjectSkill({
        selection: { ...selection, hosts: ["claude"] },
        source,
        compatibleHosts: ["pi", "codex", "opencode"],
      }, {
        projectRoot,
        sourceAccess: {
          async readSkillTree() {
            read = true;
            return tree;
          },
        },
      }),
      /incompatible.*claude.*nothing was installed/i,
    );
    assert.equal(read, false);
    await assert.rejects(lstat(path.join(projectRoot, ".agents")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects a symlinked ancestor during update preview before reading the target", async (t) => {
  const projectRoot = await makeProject();
  const outsideRoot = await makeProject();
  try {
    await mkdir(path.join(outsideRoot, "skills", "demo"), { recursive: true });
    await writeFile(path.join(outsideRoot, "skills", "demo", "SKILL.md"), "outside");
    try {
      await symlink(outsideRoot, path.join(projectRoot, ".agents"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    await assert.rejects(
      inspectProjectSkillUpdate({
        ...selection,
        installation: {
          path: ".agents/skills/demo",
          adopted: false,
          baseline: { algorithm: "sha256", digest: "a".repeat(64) },
        },
      }, {
        projectRoot,
        sourceAccess: { async readSkillTree() { throw new Error("must reject before reading"); } },
      }),
      /symbolic-link ancestor/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects a symlinked project subpath ancestor before writing outside the project", async (t) => {
  const projectRoot = await makeProject();
  const outsideRoot = await makeProject();
  try {
    try {
      await symlink(outsideRoot, path.join(projectRoot, ".agents"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    await assert.rejects(
      installProjectSkill({ selection, source, portableV1: true }, { projectRoot, sourceAccess: accessFor() }),
      /symbolic-link ancestor/i,
    );
    await assert.rejects(lstat(path.join(outsideRoot, "skills")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects a symlinked project root ancestor before reading or writing outside the project", async (t) => {
  const projectContainer = await makeProject();
  const outsideRoot = await makeProject();
  const outsideProject = path.join(outsideRoot, "subproject");
  const sentinel = path.join(outsideProject, "sentinel.txt");
  let reads = 0;
  try {
    await mkdir(outsideProject);
    await writeFile(sentinel, "outside root remains unchanged");
    try {
      await symlink(outsideRoot, path.join(projectContainer, "link"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    await assert.rejects(
      installProjectSkill({ selection, source, portableV1: true }, {
        projectRoot: path.join(projectContainer, "link", "subproject"),
        sourceAccess: {
          async readSkillTree() {
            reads += 1;
            return tree;
          },
        },
      }),
      /symbolic-link ancestor/i,
    );
    assert.equal(reads, 0);
    assert.equal(await readFile(sentinel, "utf8"), "outside root remains unchanged");
    await assert.rejects(lstat(path.join(outsideProject, ".agents")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(outsideProject, ".claude")), { code: "ENOENT" });
  } finally {
    await rm(projectContainer, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects Windows-invalid Skill names and tree segments before writing", async () => {
  for (const invalidName of ["CON", "demo:stream", "demo.", "demo "]) {
    const projectRoot = await makeProject();
    let read = false;
    try {
      const invalidSelection = { ...selection, path: `portable/${invalidName}` };
      await assert.rejects(
        installProjectSkill({ selection: invalidSelection, source, portableV1: true }, {
          projectRoot,
          sourceAccess: {
            async readSkillTree() {
              read = true;
              return [{ ...tree[0], path: `portable/${invalidName}/SKILL.md` }];
            },
          },
        }),
        /safe Skill directory name/i,
      );
      assert.equal(read, false);
      await assert.rejects(lstat(path.join(projectRoot, ".agents")), { code: "ENOENT" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }

  const projectRoot = await makeProject();
  try {
    await assert.rejects(
      installProjectSkill({ selection, source, portableV1: true }, {
        projectRoot,
        sourceAccess: accessFor([
          { ...tree[0] },
          { ...tree[1], path: "portable/demo/unsafe:stream.bin" },
          { ...tree[1], path: "portable/demo/agents/../outside.bin" },
        ]),
      }),
      /unsafe or duplicate file path/i,
    );
    await assert.rejects(lstat(path.join(projectRoot, ".agents")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("retains the other portable V1 directory exclusions", async () => {
  for (const excludedDirectory of [".claude", ".codex", ".opencode", ".pi", "extensions", "plugins", "mcp"]) {
    const projectRoot = await makeProject();
    try {
      await assert.rejects(
        installProjectSkill({
          selection,
          source,
          portableV1: true,
          previewTree: [
            tree[0]!,
            { ...tree[1]!, path: `portable/demo/${excludedDirectory}/config.json` },
          ],
        }, { projectRoot, sourceAccess: accessFor() }),
        /excluded by the portable V1 format rules/i,
      );
      await assert.rejects(lstat(path.join(projectRoot, ".agents")), { code: "ENOENT" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

test("never overwrites an existing canonical target", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "keep me");
    await assert.rejects(
      installProjectSkill({ selection, source, portableV1: true }, { projectRoot, sourceAccess: accessFor() }),
      /already exists.*explicit confirmation.*no overwrite operation.*no path was changed/i,
    );
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "keep me");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("classifies a real target collision without writing or rereading the mutable Source", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  let sourceReads = 0;
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    const inspection = await inspectProjectSkillInstallation({
      selection,
      source,
      portableV1: true,
      previewTree: tree,
    }, {
      projectRoot,
      sourceAccess: {
        async readSkillTree() {
          sourceReads += 1;
          return tree;
        },
      },
    });

    assert.equal(sourceReads, 0);
    assert.equal(inspection.targetPath, existing);
    assert.deepEqual(inspection.collision, { path: existing, reason: "content-mismatch" });
    assert.equal(inspection.locations[0]?.status, "collision");
    assert.equal(inspection.locations[1]?.status, "missing");
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "locally owned");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("overwrites one untracked real directory with a retained exact backup", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    await chmod(path.join(existing, "SKILL.md"), 0o755);
    const result = await installProjectSkill({
      selection: { ...selection, hosts: ["pi"] },
      source,
      previewTree: tree,
      portableV1: true,
      overwrite: true,
      resolvedVersion: { kind: "builtin-package", version: "0.1.0" },
    }, { projectRoot, sourceAccess: accessFor() });

    assert.ok(result.backupPath);
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "SKILL");
    assert.equal(await readFile(path.join(result.backupPath!, "SKILL.md"), "utf8"), "locally owned");
    assert.equal((await lstat(path.join(result.backupPath!, "SKILL.md"))).mode & 0o111, 0o111);
    assert.equal(await readFile(path.join(existing, "assets", "data.bin")).then((value) => value[1]), 0xff);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects an overwrite when the inspected target changes before the atomic move", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  let staged = false;
  const base = {
    lstat,
    mkdir: async (candidate: string) => { await mkdir(candidate); },
    writeFile: async (candidate: string, content: Uint8Array) => {
      await writeFile(candidate, content, { flag: "wx" });
      if (!staged && candidate.includes(".agent-depot-overwrite-")) {
        staged = true;
        await writeFile(path.join(existing, "SKILL.md"), "raced replacement");
      }
    },
    chmod: async (candidate: string, mode: number) => { await chmod(candidate, mode); },
    symlink,
    readlink,
    rm: async (candidate: string) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
    rename,
    readdir: async (candidate: string) => readdir(candidate),
    readFile: async (candidate: string) => readFile(candidate),
  } satisfies ProjectInstallationFileSystem;
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, previewTree: tree, portableV1: true, overwrite: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: base,
      }),
      /target changed before mutation/i,
    );
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "raced replacement");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("restores the moved tree when the backup changes before staged installation", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  let renames = 0;
  const base = {
    lstat,
    mkdir: async (candidate: string) => { await mkdir(candidate); },
    writeFile: async (candidate: string, content: Uint8Array) => { await writeFile(candidate, content, { flag: "wx" }); },
    chmod,
    symlink,
    readlink,
    rm: async (candidate: string) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
    rename: async (from: string, to: string) => {
      renames += 1;
      await rename(from, to);
      if (renames === 1) await writeFile(path.join(to, "SKILL.md"), "raced backup");
    },
    readdir: async (candidate: string) => readdir(candidate),
    readFile: async (candidate: string) => readFile(candidate),
  } satisfies ProjectInstallationFileSystem;
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, previewTree: tree, portableV1: true, overwrite: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: base,
      }),
      /retained backup.*differs from the preview receipt/i,
    );
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "raced backup");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("fails closed when rollback backup content changes", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    const transaction = await installProjectSkillTransaction({
      selection: { ...selection, hosts: ["pi"] },
      source,
      previewTree: tree,
      portableV1: true,
      overwrite: true,
    }, { projectRoot, sourceAccess: accessFor() });
    await writeFile(path.join(transaction.result.backupPath!, "SKILL.md"), "concurrent backup mutation");

    await assert.rejects(transaction.rollback(), /Rollback was incomplete.*retained backup.*differs/i);
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "SKILL");
    assert.equal(await readFile(path.join(transaction.result.backupPath!, "SKILL.md"), "utf8"), "concurrent backup mutation");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("preserves a concurrently modified replacement during rollback", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    const transaction = await installProjectSkillTransaction({
      selection: { ...selection, hosts: ["pi"] },
      source,
      previewTree: tree,
      portableV1: true,
      overwrite: true,
    }, { projectRoot, sourceAccess: accessFor() });
    await writeFile(path.join(existing, "SKILL.md"), "concurrent replacement mutation");

    await assert.rejects(transaction.rollback(), /Rollback was incomplete.*concurrently modified Skill/i);
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "concurrent replacement mutation");
    assert.equal(await readFile(path.join(transaction.result.backupPath!, "SKILL.md"), "utf8"), "locally owned");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects canonical overwrite when Claude is a separate identical real directory", async () => {
  const projectRoot = await makeProject();
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  try {
    await mkdir(canonicalPath, { recursive: true });
    await writeFile(path.join(canonicalPath, "SKILL.md"), "locally owned");
    await mkdir(claudePath, { recursive: true });
    for (const file of tree) {
      const destination = path.join(claudePath, ...file.path.slice("portable/demo/".length).split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content));
    }

    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi", "claude"] }, source, previewTree: tree, portableV1: true, overwrite: true }, {
        projectRoot,
        sourceAccess: accessFor(),
      }),
      /Claude location is a separate real directory.*ambiguous|separate real directory/i,
    );
    assert.equal(await readFile(path.join(canonicalPath, "SKILL.md"), "utf8"), "locally owned");
    assert.equal(await readFile(path.join(claudePath, "SKILL.md"), "utf8"), "SKILL");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("binds an overwrite to the inspected destination receipt", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    const inspection = await inspectProjectSkillInstallation({
      selection: { ...selection, hosts: ["pi"] },
      source,
      previewTree: tree,
      portableV1: true,
    }, { projectRoot, sourceAccess: accessFor() });
    await writeFile(path.join(existing, "SKILL.md"), "changed after preview");
    await assert.rejects(
      installProjectSkill({
        selection: { ...selection, hosts: ["pi"] },
        source,
        previewTree: tree,
        portableV1: true,
        overwrite: true,
        inspection,
      }, { projectRoot, sourceAccess: accessFor() }),
      /target changed before mutation/i,
    );
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "changed after preview");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rolls back an overwrite when the replacement move fails", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  let renames = 0;
  const base = {
    lstat,
    mkdir: async (candidate: string) => { await mkdir(candidate); },
    writeFile: async (candidate: string, content: Uint8Array) => { await writeFile(candidate, content, { flag: "wx" }); },
    chmod,
    symlink,
    readlink,
    rm: async (candidate: string) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
    rename: async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) throw new Error("replacement move failed");
      await rename(from, to);
    },
    readdir: async (candidate: string) => readdir(candidate),
    readFile: async (candidate: string) => readFile(candidate),
  } satisfies ProjectInstallationFileSystem;
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, previewTree: tree, portableV1: true, overwrite: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: base,
      }),
      /replacement move failed/i,
    );
    assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "locally owned");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("reports an incomplete rollback when restoring the original tree fails", async () => {
  const projectRoot = await makeProject();
  const existing = path.join(projectRoot, ".agents", "skills", "demo");
  let renames = 0;
  const base = {
    lstat,
    mkdir: async (candidate: string) => { await mkdir(candidate); },
    writeFile: async (candidate: string, content: Uint8Array) => { await writeFile(candidate, content, { flag: "wx" }); },
    chmod,
    symlink,
    readlink,
    rm: async (candidate: string) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
    rename: async (from: string, to: string) => {
      renames += 1;
      if (renames === 2 || renames === 3) throw new Error("restore denied");
      await rename(from, to);
    },
    readdir: async (candidate: string) => readdir(candidate),
    readFile: async (candidate: string) => readFile(candidate),
  } satisfies ProjectInstallationFileSystem;
  try {
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "SKILL.md"), "locally owned");
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, previewTree: tree, portableV1: true, overwrite: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: base,
      }),
      /rollback was incomplete.*restore denied/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rolls back the canonical target when Claude symlink creation fails", async () => {
  const projectRoot = await makeProject();
  const baseFileSystem: ProjectInstallationFileSystem = {
    lstat,
    mkdir: async (candidate) => { await mkdir(candidate); },
    writeFile: async (candidate, content) => { await writeFile(candidate, content, { flag: "wx" }); },
    chmod,
    symlink: async () => { throw new Error("operation not permitted"); },
    readlink,
    rm: async (candidate) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
  };
  try {
    await assert.rejects(
      installProjectSkill({ selection, source, portableV1: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: baseFileSystem,
      }),
      /Claude Skill symlink.*operation not permitted.*no duplicate managed copy.*rolled back/i,
    );
    await assert.rejects(lstat(path.join(projectRoot, ".agents", "skills", "demo")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(projectRoot, ".claude", "skills", "demo")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("does not delete a concurrently replaced file during rollback and reports incomplete cleanup", async () => {
  const projectRoot = await makeProject();
  let writes = 0;
  const baseFileSystem: ProjectInstallationFileSystem = {
    lstat,
    mkdir: async (candidate) => { await mkdir(candidate); },
    writeFile: async (candidate, content) => {
      writes += 1;
      if (writes === 2) throw new Error("injected write failure");
      await writeFile(candidate, content, { flag: "wx" });
    },
    chmod: async (candidate, mode) => {
      await chmod(candidate, mode);
      if (candidate.endsWith(path.join("demo", "SKILL.md"))) {
        await rm(candidate);
        await writeFile(candidate, "concurrent replacement");
      }
    },
    symlink: async (target, candidate, type) => { await symlink(target, candidate, type); },
    readlink,
    rm: async (candidate) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
  };
  try {
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, portableV1: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: baseFileSystem,
      }),
      /injected write failure.*rollback was incomplete.*concurrently replaced/i,
    );
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "concurrent replacement");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("surfaces cleanup failures instead of hiding them", async () => {
  const projectRoot = await makeProject();
  let writes = 0;
  const baseFileSystem: ProjectInstallationFileSystem = {
    lstat,
    mkdir: async (candidate) => { await mkdir(candidate); },
    writeFile: async (candidate, content) => {
      writes += 1;
      if (writes === 2) throw new Error("injected write failure");
      await writeFile(candidate, content, { flag: "wx" });
    },
    chmod,
    symlink: async (target, candidate, type) => { await symlink(target, candidate, type); },
    readlink,
    rm: async (candidate) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir: async (candidate) => {
      if (candidate.endsWith(path.join("skills", "demo"))) throw new Error("cleanup denied");
      await rmdir(candidate);
    },
  };
  try {
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, portableV1: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: baseFileSystem,
      }),
      /injected write failure.*rollback was incomplete.*cleanup denied/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rolls back a partially written target after an injected file failure", async () => {
  const projectRoot = await makeProject();
  let writes = 0;
  const baseFileSystem: ProjectInstallationFileSystem = {
    lstat,
    mkdir: async (candidate) => { await mkdir(candidate); },
    writeFile: async (candidate, content) => {
      writes += 1;
      if (writes === 2) throw new Error("injected write failure");
      await writeFile(candidate, content, { flag: "wx" });
    },
    chmod,
    symlink: async (target, candidate, type) => { await symlink(target, candidate, type); },
    readlink,
    rm: async (candidate) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
  };
  try {
    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["pi"] }, source, portableV1: true }, {
        projectRoot,
        sourceAccess: accessFor(),
        fileSystem: baseFileSystem,
      }),
      /injected write failure/,
    );
    await assert.rejects(lstat(path.join(projectRoot, ".agents", "skills", "demo")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("refuses a symlink collision during read-only inspection", async (t) => {
  const projectRoot = await makeProject();
  const outsideRoot = await makeProject();
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    try {
      await mkdir(path.dirname(canonicalPath), { recursive: true });
      await symlink(outsideRoot, canonicalPath, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    const inspection = await inspectProjectSkillInstallation({ selection, source, portableV1: true, previewTree: tree }, {
      projectRoot,
      sourceAccess: accessFor(),
    });
    assert.equal(inspection.targetPath, canonicalPath);
    assert.deepEqual(inspection.collision, { path: canonicalPath, reason: "symbolic-link" });
    await assert.rejects(lstat(path.join(outsideRoot, "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("adopts an identical canonical Skill in place without writing it", async () => {
  const projectRoot = await makeProject();
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(canonicalPath, { recursive: true });
    await mkdir(path.join(canonicalPath, "assets"));
    await mkdir(path.join(canonicalPath, "scripts"));
    await writeFile(path.join(canonicalPath, "SKILL.md"), Buffer.from(tree[0]!.content));
    await writeFile(path.join(canonicalPath, "assets", "data.bin"), Buffer.from(tree[1]!.content));
    await writeFile(path.join(canonicalPath, "scripts", "run.sh"), Buffer.from(tree[2]!.content));
    const before = await lstat(canonicalPath);

    const result = await installProjectSkill({
      selection: { ...selection, hosts: ["pi"] },
      source,
      portableV1: true,
    }, { projectRoot, sourceAccess: accessFor() });

    assert.equal(result.adopted, true);
    assert.deepEqual(result.adoptedPaths, [canonicalPath]);
    assert.equal((await lstat(canonicalPath)).ino, before.ino);
    assert.equal(await readFile(path.join(canonicalPath, "SKILL.md"), "utf8"), "SKILL");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("adopts an identical noncanonical Claude directory in place", async () => {
  const projectRoot = await makeProject();
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  try {
    await mkdir(claudePath, { recursive: true });
    await mkdir(path.join(claudePath, "assets"));
    await mkdir(path.join(claudePath, "scripts"));
    await writeFile(path.join(claudePath, "SKILL.md"), Buffer.from(tree[0]!.content));
    await writeFile(path.join(claudePath, "assets", "data.bin"), Buffer.from(tree[1]!.content));
    await writeFile(path.join(claudePath, "scripts", "run.sh"), Buffer.from(tree[2]!.content));

    const result = await installProjectSkill({
      selection: { ...selection, hosts: ["claude"] },
      source,
      portableV1: true,
    }, { projectRoot, sourceAccess: accessFor() });

    assert.equal(result.adopted, true);
    assert.equal(result.canonicalPath, claudePath);
    assert.deepEqual(result.adoptedPaths, [claudePath]);
    assert.equal((await lstat(claudePath)).isSymbolicLink(), false);
    await assert.rejects(lstat(path.join(projectRoot, ".agents")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("adopts a canonical Skill and its Claude symlink on a repeat installation", async (t) => {
  const projectRoot = await makeProject();
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  try {
    try {
      await mkdir(canonicalPath, { recursive: true });
      for (const file of tree) {
        const relativePath = file.path.slice("portable/demo/".length);
        const destination = path.join(canonicalPath, ...relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(file.content));
      }
      await mkdir(path.dirname(claudePath), { recursive: true });
      await symlink(path.relative(path.dirname(claudePath), canonicalPath), claudePath, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    const result = await installProjectSkill({ selection, source, portableV1: true }, {
      projectRoot,
      sourceAccess: accessFor(),
    });

    assert.equal(result.adopted, true);
    assert.equal(result.canonicalPath, canonicalPath);
    assert.equal(result.claudePath, claudePath);
    assert.deepEqual(result.adoptedPaths, [canonicalPath, claudePath]);
    assert.equal(await readlink(claudePath), path.relative(path.dirname(claudePath), canonicalPath));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects an unrelated Claude Skill symlink during adoption", async (t) => {
  const projectRoot = await makeProject();
  const unrelatedTarget = await makeProject();
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  try {
    try {
      await mkdir(path.dirname(claudePath), { recursive: true });
      await symlink(unrelatedTarget, claudePath, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    await assert.rejects(
      installProjectSkill({ selection: { ...selection, hosts: ["claude"] }, source, portableV1: true }, {
        projectRoot,
        sourceAccess: accessFor(),
      }),
      /does not point to the existing canonical Skill/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(unrelatedTarget, { recursive: true, force: true });
  }
});

test("adds a missing Claude exposure only with separate explicit confirmation", async (t) => {
  const projectRoot = await makeProject();
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  try {
    try {
      await mkdir(canonicalPath, { recursive: true });
      for (const file of tree) {
        const relativePath = file.path.slice("portable/demo/".length);
        const destination = path.join(canonicalPath, ...relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(file.content));
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    const result = await installProjectSkill({
      selection,
      source,
      portableV1: true,
      confirmAdditionalHostExposure: true,
    }, { projectRoot, sourceAccess: accessFor() });

    assert.equal(result.adopted, true);
    assert.deepEqual(result.adoptedPaths, [canonicalPath, claudePath]);
    assert.equal(await readlink(claudePath), path.relative(path.dirname(claudePath), canonicalPath));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("does not add missing Claude exposure during adoption", async () => {
  const projectRoot = await makeProject();
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  try {
    await mkdir(canonicalPath, { recursive: true });
    for (const file of tree) {
      const relativePath = file.path.slice("portable/demo/".length);
      const destination = path.join(canonicalPath, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content));
    }

    await assert.rejects(
      installProjectSkill({ selection, source, portableV1: true }, { projectRoot, sourceAccess: accessFor() }),
      /missing Claude exposure.*explicit confirmation.*will not create/i,
    );
    await assert.rejects(lstat(path.join(projectRoot, ".claude")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(canonicalPath, "SKILL.md"), "utf8"), "SKILL");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function writeDemoTree(root: string): Promise<void> {
  for (const file of tree) {
    const destination = path.join(root, ...file.path.slice("portable/demo/".length).split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.content));
  }
}

function adoptionFileSystem(overrides: Partial<ProjectInstallationFileSystem> = {}): ProjectInstallationFileSystem {
  return {
    lstat,
    mkdir: async (candidate: string) => { await mkdir(candidate); },
    writeFile: async (candidate: string, content: Uint8Array) => { await writeFile(candidate, content, { flag: "wx" }); },
    chmod: async (candidate: string, mode: number) => { await chmod(candidate, mode); },
    symlink,
    readlink,
    rm: async (candidate: string) => { await rm(candidate, { recursive: true, force: true }); },
    rmdir,
    rename,
    readdir: async (candidate: string) => readdir(candidate),
    readFile: async (candidate: string) => readFile(candidate),
    ...overrides,
  };
}

async function adoptionScenario(
  prepare: (projectRoot: string, canonicalPath: string, claudePath: string) => Promise<void>,
  options: { hosts?: ProjectSkillSelection["hosts"]; confirm?: boolean; fileSystem?: ProjectInstallationFileSystem } = {},
): Promise<{ error: Error | undefined; projectRoot: string }> {
  const projectRoot = await makeProject();
  try {
    await prepare(projectRoot, path.join(projectRoot, ".agents", "skills", "demo"), path.join(projectRoot, ".claude", "skills", "demo"));
    try {
      await installProjectSkill({
        selection: { ...selection, hosts: options.hosts ?? ["pi"] },
        source,
        portableV1: true,
        ...(options.confirm === true ? { confirmAdditionalHostExposure: true } : {}),
      }, { projectRoot, sourceAccess: accessFor(), fileSystem: options.fileSystem ?? adoptionFileSystem() });
      return { error: undefined, projectRoot };
    } catch (error) {
      return { error: error as Error, projectRoot };
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("adoption refuses an existing Skill with different content", async () => {
  const { error } = await adoptionScenario(async (_root, canonicalPath) => {
    await writeDemoTree(canonicalPath);
    await writeFile(path.join(canonicalPath, "SKILL.md"), "locally edited");
  });
  assert.match(error?.message ?? "", /already exists at .* with different content \(.*\); explicit confirmation would be required to overwrite it.*No path was changed\.$/u);
});

test("adoption refuses an existing Skill path that is not a directory", async () => {
  const { error } = await adoptionScenario(async (_root, canonicalPath) => {
    await mkdir(path.dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, "not a directory");
  });
  assert.match(error?.message ?? "", /the existing Skill path .* is not a directory; explicit confirmation would be required.*No path was changed\.$/u);
});

test("adoption reports an uninspectable existing Skill and a missing reader adapter", async () => {
  const unreadable = await adoptionScenario(async (_root, canonicalPath) => {
    await writeDemoTree(canonicalPath);
  }, { fileSystem: adoptionFileSystem({ readFile: async () => { throw new Error("boom"); } }) });
  assert.match(unreadable.error?.message ?? "", /Cannot safely inspect existing Skill at .*: .*boom.* No path was changed\.$/u);

  const noReaders = await adoptionScenario(async (_root, canonicalPath) => {
    await writeDemoTree(canonicalPath);
  }, { fileSystem: adoptionFileSystem({ readdir: undefined, readFile: undefined }) });
  assert.match(noReaders.error?.message ?? "", /Cannot safely inspect existing Skill at .*directory reading is unavailable; retry with the standard filesystem adapter\./u);

  const noFileReader = await adoptionScenario(async (_root, canonicalPath) => {
    await writeDemoTree(canonicalPath);
  }, { fileSystem: adoptionFileSystem({ readFile: undefined }) });
  assert.match(noFileReader.error?.message ?? "", /file reading is unavailable; retry with the standard filesystem adapter\./u);
});

test("adoption never moves or copies a Claude-only Skill to another Host location", async () => {
  const withoutConfirmation = await adoptionScenario(async (_root, _canonical, claudePath) => {
    await writeDemoTree(claudePath);
  });
  assert.match(withoutConfirmation.error?.message ?? "", /adding the missing another Host location requires explicit confirmation.*Re-run with --confirm-additional-host and --yes\.$/u);

  const withConfirmation = await adoptionScenario(async (_root, _canonical, claudePath) => {
    await writeDemoTree(claudePath);
  }, { confirm: true });
  assert.match(withConfirmation.error?.message ?? "", /would require moving or copying it; this operation does not move or duplicate adopted Skills, so no path was changed\.$/u);
});

test("adoption reports a failing additional Claude symlink", async () => {
  const { error } = await adoptionScenario(async (_root, canonicalPath) => {
    await writeDemoTree(canonicalPath);
  }, {
    hosts: ["pi", "claude"],
    confirm: true,
    fileSystem: adoptionFileSystem({ symlink: async () => { throw new Error("denied"); } }),
  });
  assert.match(error?.message ?? "", /Cannot create the additional Claude Skill symlink at .*: denied\. No existing path was changed\.$/u);
});
