import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BUILT_IN_SOURCE,
  createSourceOperations,
  executeSourceInstallationMethod,
  parseSourceInstallationMethod,
  SourceNotFoundError,
  type SourceOperations,
} from "../src/sources.js";
import type { SkillTreeFile } from "../src/skill-discovery.js";
import { AGENT_DEPOT_PACKAGE_VERSION } from "../src/project-manifest.js";
import { runCli } from "../src/cli.js";

const external = {
  id: "git:1234567890abcdef12345678",
  kind: "git" as const,
  url: "https://github.com/example/skills.git",
};

function fakeOperations(overrides: Partial<SourceOperations> = {}): SourceOperations {
  return {
    async addGitSource() {
      return external;
    },
    async listSources() {
      return [BUILT_IN_SOURCE, external];
    },
    async refreshSource() {
      return external;
    },
    async selectSources() {
      return [external];
    },
    ...overrides,
  };
}

test("runs through direct and symlinked package entrypoints", async (t) => {
  const cliPath = path.resolve("dist/src/cli.js");
  const direct = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /Usage:/);

  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-"));
  try {
    const linkedPath = path.join(directory, "agent-depot");
    try {
      await symlink(cliPath, linkedPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const linked = spawnSync(process.execPath, [linkedPath], { encoding: "utf8" });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists Sources and marks the built-in Source read-only", async () => {
  const output: string[] = [];

  const exitCode = await runCli(["source", "list"], {
    operations: fakeOperations(),
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(`stderr: ${line}`),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(output, [
    "builtin:agent-depot\tbuiltin\tAgent Depot\tread-only",
    `${external.id}\tgit\t${external.url}`,
  ]);
});

test("adds a Source and requires explicit refresh confirmation before network access", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const calls: string[] = [];
  const operations = fakeOperations({
    async addGitSource(url) {
      calls.push(`add:${url}`);
      return external;
    },
    async refreshSource(id) {
      calls.push(`refresh:${id}`);
      return external;
    },
  });

  assert.equal(await runCli(["source", "add", external.url], { operations, stdout: (line) => output.push(line) }), 0);
  assert.equal(await runCli(["source", "refresh", external.id], {
    operations,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  }), 1);
  assert.equal(await runCli(["source", "refresh", external.id, "--yes"], {
    operations,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  }), 0);

  assert.deepEqual(calls, [`add:${external.url}`, `refresh:${external.id}`]);
  assert.deepEqual(output, [
    `Added Git Source: ${external.id}\t${external.url}`,
    `Preview: refresh Git Source ${external.id} from ${external.url}`,
    `Preview: refresh Git Source ${external.id} from ${external.url}`,
    `Refreshed Git Source: ${external.id}\t${external.url}`,
  ]);
  assert.deepEqual(errors, ["Error: Refresh not confirmed; rerun with --yes to continue"]);
});

test("does not expose discovery selection or refresh the built-in Source", async () => {
  const errors: string[] = [];
  const operations = fakeOperations({
    async refreshSource() {
      throw new Error("refresh should not be called");
    },
  });

  assert.equal(await runCli(["source", "select", external.id], {
    operations,
    stderr: (line) => errors.push(line),
  }), 1);
  assert.equal(await runCli(["source", "refresh", BUILT_IN_SOURCE.id, "--yes"], {
    operations,
    stderr: (line) => errors.push(line),
  }), 1);
  assert.deepEqual(errors, [
    "Error: Usage:\n  agent-depot source list\n  agent-depot source add <url>\n  agent-depot source refresh <id> [--yes]\n  agent-depot discover <source-id> [source-id...]\n  agent-depot install --scope project --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] --portable-v1 [--yes]\n  agent-depot install --scope project --manifest --portable-v1 [--yes]",
    "Error: The package-owned built-in Source cannot be refreshed or changed",
  ]);
});

test("discovers candidates from the explicitly supplied Source IDs", async () => {
  const output: string[] = [];
  const calls: string[][] = [];
  const operations = fakeOperations({
    async listSources() {
      throw new Error("discover must not select Sources through the CLI");
    },
    async discoverSkills(sourceIds) {
      calls.push([...sourceIds]);
      return [{
        sourceId: external.id,
        path: "chosen",
        name: "Chosen",
        description: "Chosen skill",
      }];
    },
  });

  const exitCode = await runCli(["discover", BUILT_IN_SOURCE.id, external.id], {
    operations,
    stdout: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [[BUILT_IN_SOURCE.id, external.id]]);
  assert.deepEqual(output, [
    `Candidate: ${external.id}\tchosen\tChosen\tChosen skill`,
  ]);
});

test("requires at least one explicit Source ID for discovery", async () => {
  const errors: string[] = [];
  let called = false;
  const operations = fakeOperations({
    async discoverSkills() {
      called = true;
      return [];
    },
  });

  const exitCode = await runCli(["discover"], {
    operations,
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.deepEqual(errors, [
    "Error: Usage: agent-depot discover <source-id> [source-id...]\nSelect at least one Source ID explicitly; run `agent-depot source list` to see registered Sources",
  ]);
});

test("reports how to recover when a selected Source is not registered", async () => {
  const errors: string[] = [];
  const operations = fakeOperations({
    async discoverSkills() {
      throw new SourceNotFoundError("git:missing");
    },
  });

  const exitCode = await runCli(["discover", "git:missing"], {
    operations,
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, [
    "Error: Source is not registered: git:missing. Run `agent-depot source list` and pass a registered Source ID",
  ]);
});

const cliTree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Uint8Array.from([0x23, 0x23, 0x20, 0x44]), executable: false },
  { path: "portable/demo/scripts/run.sh", content: Uint8Array.from([0x23, 0x21, 0x2f, 0x62]), executable: true },
];

function cliSourceAccess(tree: readonly SkillTreeFile[] = cliTree) {
  return {
    async readSkillTree(source: typeof BUILT_IN_SOURCE, skillPath: string) {
      assert.equal(source.id, BUILT_IN_SOURCE.id);
      assert.equal(skillPath, "portable/demo");
      return tree;
    },
  };
}

test("previews project selection before confirmation, then installs and persists identity", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-project-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const args = ["install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo", "--host", "pi,claude", "--version", "latest", "--portable-v1"];

    assert.equal(await runCli(args, dependencies), 1);
    assert.match(output[0] ?? "", /Preview: install Skill/);
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    await assert.rejects(readFile(path.join(projectRoot, "agent-depot.json")), { code: "ENOENT" });

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ source: { kind: string; id: string }; path: string; version: { policy: string; version?: string }; hosts: string[] }>;
    };
    assert.deepEqual(manifest.skills[0], {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi", "claude"],
    });
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    assert.equal(errors.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("accepts the installed package version for built-in fixed policy and rejects unavailable versions", async () => {
  const matchingRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-package-version-"));
  const mismatchedRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-package-mismatch-"));
  const mismatchErrors: string[] = [];
  try {
    const baseArgs = [
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--portable-v1",
    ];
    assert.equal(await runCli([...baseArgs, "--version", `fixed:${AGENT_DEPOT_PACKAGE_VERSION}`, "--yes"], {
      operations: fakeOperations(),
      projectRoot: matchingRoot,
      sourceAccess: cliSourceAccess(),
    }), 0);
    const matchingManifest = JSON.parse(await readFile(path.join(matchingRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ version: { policy: string; version?: string } }>;
    };
    assert.deepEqual(matchingManifest.skills[0]?.version, {
      policy: "fixed",
      version: AGENT_DEPOT_PACKAGE_VERSION,
    });

    assert.equal(await runCli([...baseArgs, "--version", `fixed:${AGENT_DEPOT_PACKAGE_VERSION}-unavailable`, "--yes"], {
      operations: fakeOperations(),
      projectRoot: mismatchedRoot,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => mismatchErrors.push(line),
    }), 1);
    assert.match(mismatchErrors[0] ?? "", /must equal the current Agent Depot package version.*cannot be reproduced by this package/);
    await assert.rejects(readFile(path.join(mismatchedRoot, "agent-depot.json")), { code: "ENOENT" });
  } finally {
    await rm(matchingRoot, { recursive: true, force: true });
    await rm(mismatchedRoot, { recursive: true, force: true });
  }
});

test("rejects --ref for the built-in Source instead of silently ignoring it", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-builtin-ref-"));
  const errors: string[] = [];
  try {
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--ref", "main", "--portable-v1", "--yes",
    ], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => errors.push(line),
    }), 1);
    assert.deepEqual(errors, ["Error: The built-in Source does not support --ref; its version follows the Agent Depot package"]);
    await assert.rejects(readFile(path.join(projectRoot, "agent-depot.json")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolves a project manifest on a fresh machine without global Source lookup", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-fresh-"));
  const calls: string[] = [];
  try {
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{
        source: { kind: "external", url: external.url, ref: "main" },
        path: "portable/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
      }],
    }), "utf8");
    const operations = fakeOperations({
      async listSources() {
        throw new Error("fresh-machine install must not consult global Source state");
      },
      async resolveProjectSource(projectSource) {
        assert.equal(projectSource.kind, "external");
        return external;
      },
      async refreshProjectSource(projectSource) {
        calls.push(`refresh:${projectSource.kind === "external" && "url" in projectSource ? projectSource.url : "unknown"}`);
        return external;
      },
    });
    const errors: string[] = [];
    assert.equal(await runCli(["install", "--scope", "project", "--manifest", "--portable-v1", "--yes"], {
      operations,
      projectRoot,
      sourceAccess: {
        async readSkillTree(source, skillPath) {
          assert.equal(source.id, external.id);
          assert.equal(skillPath, "portable/demo");
          return cliTree;
        },
      },
      stderr: (line) => errors.push(line),
    }), 0);
    assert.deepEqual(calls, [`refresh:${external.url}`]);
    assert.deepEqual(errors, []);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("executes a reviewed structured method only after the complete preview and confirmation", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-safe-method-"));
  const output: string[] = [];
  const calls: Array<{ argv: readonly string[]; cwd?: string }> = [];
  try {
    const operations = fakeOperations({
      async readInstallationMethod() {
        return { kind: "command", argv: ["node", "--version"], cwd: "." };
      },
      async executeInstallationMethod(method, context) {
        calls.push({ argv: method.argv, cwd: path.resolve(context.projectRoot, method.cwd ?? ".") });
      },
    });
    const args = [
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi,claude", "--version", "latest", "--portable-v1",
    ];
    assert.equal(await runCli(args, { operations, projectRoot, sourceAccess: cliSourceAccess(), stdout: (line) => output.push(line) }), 1);
    assert.deepEqual(calls, []);
    assert.match(output.join("\\n"), /args=\["--version"\].*cwd=/);
    assert.equal(await runCli([...args, "--yes"], { operations, projectRoot, sourceAccess: cliSourceAccess(), stdout: (line) => output.push(line) }), 0);
    assert.deepEqual(calls, [{ argv: ["node", "--version"], cwd: projectRoot }]);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    assert.equal(await readlink(path.join(projectRoot, ".claude", "skills", "demo")), path.relative(
      path.join(projectRoot, ".claude", "skills"),
      path.join(projectRoot, ".agents", "skills", "demo"),
    ));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rolls back installed files when the manifest transaction cannot be committed", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-manifest-rollback-"));
  try {
    const store = {
      path: path.join(projectRoot, "agent-depot.json"),
      async load() {
        return { version: 1 as const, skills: [] as const };
      },
      async save() {
        throw new Error("manifest storage unavailable");
      },
    };
    const errors: string[] = [];
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      projectManifestStore: store,
      stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors[0] ?? "", /manifest storage unavailable/);
    await assert.rejects(readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("reads source methods only from explicit JSON metadata files, never SKILL.md prose", async () => {
  const operations = createSourceOperations({
    sourceContentAccess: {
      async readSnapshot() {
        return [];
      },
      async readSkillTree() {
        return [
          { path: "portable/demo/SKILL.md", content: Uint8Array.from(Buffer.from("run: sh -c unsafe")), executable: false },
          { path: "portable/demo/.agent-depot.json", content: Uint8Array.from(Buffer.from(JSON.stringify({
            method: { kind: "command", argv: ["node", "--version"] },
          }))), executable: false },
        ];
      },
    },
  });
  assert.deepEqual(await operations.readInstallationMethod?.(BUILT_IN_SOURCE, "portable/demo"), {
    kind: "command",
    argv: ["node", "--version"],
  });
});

test("rejects Windows shell-interpreter executable variants", () => {
  for (const executable of ["cmd.exe", "powershell.exe", "pwsh.exe", "sh.exe", "install.cmd"]) {
    assert.throws(
      () => parseSourceInstallationMethod({ kind: "command", argv: [executable] }),
      /safe no-shell command name/,
    );
  }
});

test("executes a safe default method with the exact argv and rejects a failed child", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-spawn-"));
  const marker = path.join(projectRoot, "argv.txt");
  try {
    const method = parseSourceInstallationMethod({
      kind: "command",
      argv: ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf8')", marker, "safe argv"],
      cwd: ".",
    });
    await executeSourceInstallationMethod(method, {
      source: BUILT_IN_SOURCE,
      skillPath: "portable/demo",
      projectRoot,
    });
    assert.equal(await readFile(marker, "utf8"), "safe argv");

    const failingMethod = parseSourceInstallationMethod({
      kind: "command",
      argv: ["node", "-e", "process.exitCode=7"],
    });
    await assert.rejects(
      executeSourceInstallationMethod(failingMethod, {
        source: BUILT_IN_SOURCE,
        skillPath: "portable/demo",
        projectRoot,
      }),
      /upstream installation method failed.*exit 7/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects a realpath cwd that escapes the project root", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-cwd-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-outside-"));
  try {
    try {
      await symlink(outsideRoot, path.join(projectRoot, "linked"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(
      executeSourceInstallationMethod(
        { kind: "command", argv: ["node", "--version"], cwd: "linked" },
        { source: BUILT_IN_SOURCE, skillPath: "portable/demo", projectRoot },
      ),
      /escapes the project root after realpath/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("reads method metadata from the preview snapshot instead of a mutable latest tree", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-snapshot-"));
  const previewTree: readonly SkillTreeFile[] = [
    ...cliTree,
    {
      path: "portable/demo/.agent-depot.json",
      content: Uint8Array.from(Buffer.from(JSON.stringify({ method: { kind: "command", argv: ["node", "--version"] } }))),
      executable: false,
    },
  ];
  let mutableReadCount = 0;
  const sourceContentAccess = {
    async readSnapshot() {
      return [];
    },
    async readSkillTree() {
      mutableReadCount += 1;
      throw new Error("mutable latest tree must not be read after preview");
    },
  };
  const baseOperations = createSourceOperations({ sourceContentAccess });
  const calls: string[][] = [];
  try {
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ], {
      operations: {
        ...baseOperations,
        async listSources() {
          return [BUILT_IN_SOURCE];
        },
        async executeInstallationMethod(method) {
          calls.push([...method.argv]);
        },
      },
      projectRoot,
      sourceAccess: {
        async readSkillTree() {
          return previewTree;
        },
      },
    }), 0);
    assert.deepEqual(calls, [["node", "--version"]]);
    assert.equal(mutableReadCount, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("persists the manifest before a method failure and does not promise rollback", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-method-failure-"));
  const errors: string[] = [];
  try {
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ], {
      operations: fakeOperations({
        async readInstallationMethod() {
          return { kind: "command", argv: ["node", "--version"] };
        },
        async executeInstallationMethod() {
          throw new Error("method side effect failed");
        },
      }),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors[0] ?? "", /retained because method side effects cannot be rolled back/);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as { skills: unknown[] };
    assert.equal(manifest.skills.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("refuses unsafe or unsupported upstream methods without executing commands", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-method-"));
  const errors: string[] = [];
  let executed = false;
  try {
    const operations = fakeOperations({
      async readInstallationMethod() {
        return { kind: "command", argv: ["sh", "-c", "rm -rf ."] };
      },
      async executeInstallationMethod() {
        executed = true;
      },
    });
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo", "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ], {
      operations,
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => errors.push(line),
    }), 1);
    assert.equal(executed, false);
    assert.match(errors[0] ?? "", /executable is not a safe no-shell command name/);
    await assert.rejects(readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
