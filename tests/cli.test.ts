import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
import { AGENT_DEPOT_PACKAGE_VERSION, type ProjectSkillSelection } from "../src/project-manifest.js";
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
    "Error: Usage:\n  agent-depot source list\n  agent-depot source add <url>\n  agent-depot source refresh <id> [--yes]\n  agent-depot discover <source-id> [source-id...]\n  agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--yes] [--confirm-additional-host]\n  agent-depot install --scope project --manifest --portable-v1 [--yes] [--confirm-additional-host]",
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

test("discovers built-in candidates through the CLI using real Source operations", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-discover-state-"));
  const builtInRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-discover-builtin-"));
  const output: string[] = [];
  try {
    const skillDirectory = path.join(builtInRoot, "portable", "demo");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), [
      "---",
      "name: Demo",
      "description: Demo skill",
      "---",
      "",
      "# Demo",
      "",
    ].join("\n"), "utf8");

    const operations = createSourceOperations({
      statePath: path.join(stateDirectory, "sources.json"),
      builtInRoot,
    });
    const exitCode = await runCli(["discover", BUILT_IN_SOURCE.id], {
      operations,
      stdout: (line) => output.push(line),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(output, [
      `Candidate: ${BUILT_IN_SOURCE.id}\tportable/demo\tDemo\tDemo skill`,
    ]);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(builtInRoot, { recursive: true, force: true });
  }
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
    assert.match(output[0] ?? "", /Preview: reconcile Skill/);
    assert.ok(output.some((line) => /fresh install.*symlink.*--yes/i.test(line)));
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
      installation: { path: ".agents/skills/demo", adopted: false },
    });
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    assert.equal(errors.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("previews and installs a user-global Skill in the injected home while sharing Source state", async (t) => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-state-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    try {
      await symlink(path.join(homeDirectory, "missing-target"), path.join(homeDirectory, "link-check"), "dir");
      await rm(path.join(homeDirectory, "link-check"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const args = [
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi,claude", "--version", "latest", "--portable-v1",
    ];
    const dependencies = {
      operations,
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(args, dependencies), 1);
    assert.ok(output.some((line) => line.includes("scope: user-global")));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    await assert.rejects(readFile(path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    assert.equal(await readlink(path.join(homeDirectory, ".claude", "skills", "demo")), path.relative(
      path.join(homeDirectory, ".claude", "skills"),
      path.join(homeDirectory, ".agents", "skills", "demo"),
    ));
    await assert.rejects(readFile(path.join(homeDirectory, "agent-depot.json")), { code: "ENOENT" });
    const state = JSON.parse(await readFile(path.join(stateDirectory, "sources.json"), "utf8")) as {
      userGlobalInstallations: Array<{ path: string; installation?: { path: string; adopted: boolean } }>;
    };
    assert.deepEqual(state.userGlobalInstallations[0]?.installation, {
      path: ".agents/skills/demo",
      adopted: false,
    });
    const sharedOperations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    assert.ok(sharedOperations.listUserGlobalInstallations);
    assert.equal((await sharedOperations.listUserGlobalInstallations()).length, 1);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("adopts an identical existing user-global Skill without replacing it", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-adoption-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-adoption-state-"));
  const canonicalPath = path.join(homeDirectory, ".agents", "skills", "demo");
  const output: string[] = [];
  try {
    await mkdir(canonicalPath, { recursive: true });
    for (const file of cliTree) {
      const relativePath = file.path.slice("portable/demo/".length);
      const destination = path.join(canonicalPath, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content));
    }
    const before = await lstat(canonicalPath);
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const exitCode = await runCli([
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ], {
      operations,
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stdout: (line) => output.push(line),
    });

    assert.equal(exitCode, 0);
    assert.equal((await lstat(canonicalPath)).ino, before.ino);
    assert.ok(output.some((line) => /Adopted Skill.*\.agents[\\\\/]skills[\\\\/]demo/u.test(line)));
    const records = operations.listUserGlobalInstallations;
    assert.ok(records);
    assert.equal((await records()).find((item) => item.path === "portable/demo")?.installation?.adopted, true);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("requires separate adoption confirmation and persists the actual adopted location", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-adoption-"));
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  const errors: string[] = [];
  const output: string[] = [];
  try {
    await mkdir(canonicalPath, { recursive: true });
    for (const file of cliTree) {
      const relativePath = file.path.slice("portable/demo/".length);
      const destination = path.join(canonicalPath, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content));
    }

    const baseArgs = [
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi,claude", "--version", "latest", "--portable-v1", "--yes",
    ];
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(baseArgs, dependencies), 1);
    assert.match(errors[0] ?? "", /missing Claude exposure requires explicit confirmation/i);
    assert.ok(output.some((line) => /adopt if identical/i.test(line)));
    assert.equal(output.some((line) => /^\s+create(?: symlink)?:/u.test(line)), false);
    await assert.rejects(readFile(path.join(projectRoot, ".claude", "skills", "demo", "SKILL.md")), { code: "ENOENT" });

    assert.equal(await runCli([...baseArgs, "--confirm-additional-host"], dependencies), 0);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ installation?: { path: string; adopted: boolean } }>;
    };
    assert.deepEqual(manifest.skills[0]?.installation, {
      path: ".agents/skills/demo",
      adopted: true,
    });
    assert.match(output.join("\\n"), /Adopted Skill.*\.agents[\\\\/]skills[\\\\/]demo/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("previews selected source files and known locations before adopting a Claude-only Skill in place", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-claude-adoption-"));
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  const errors: string[] = [];
  const output: string[] = [];
  try {
    await mkdir(claudePath, { recursive: true });
    for (const file of cliTree) {
      const relativePath = file.path.slice("portable/demo/".length);
      const destination = path.join(claudePath, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content));
    }
    const originalSkill = await readFile(path.join(claudePath, "SKILL.md"), "utf8");
    const args = [
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "claude", "--version", "latest", "--portable-v1",
    ];
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(args, dependencies), 1);
    const preview = [...output];
    assert.ok(preview.some((line) => /destination determined by safe inspection/i.test(line)));
    assert.ok(preview.some((line) => line.includes("selected source files:")));
    assert.ok(preview.some((line) => line.includes("portable/demo/SKILL.md")));
    assert.ok(preview.some((line) => line.includes("possible project locations:")));
    assert.ok(preview.some((line) => line.includes(path.join(projectRoot, ".claude", "skills", "demo"))));
    assert.equal(preview.some((line) => /reconcile:.*\.agents[\\/]/u.test(line)), false);
    output.length = 0;
    errors.length = 0;

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);

    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ installation?: { path: string; adopted: boolean } }>;
    };
    assert.deepEqual(manifest.skills[0]?.installation, {
      path: ".claude/skills/demo",
      adopted: true,
    });
    assert.equal(await readFile(path.join(claudePath, "SKILL.md"), "utf8"), originalSkill);
    await assert.rejects(lstat(path.join(projectRoot, ".agents", "skills", "demo")), { code: "ENOENT" });
    assert.deepEqual(errors, []);
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

test("prefers a configured install method, previews it without execution, and persists install/update methods", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-configured-method-"));
  const output: string[] = [];
  const errors: string[] = [];
  const calls: string[][] = [];
  let sourceMethodReads = 0;
  try {
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: "portable/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
        methods: {
          install: { kind: "command", argv: ["node", "--configured-install"], cwd: "tools" },
          update: { kind: "command", argv: ["node", "--configured-update"] },
        },
      }],
    }), "utf8");
    const operations = fakeOperations({
      async readInstallationMethod() {
        sourceMethodReads += 1;
        return { kind: "command", argv: ["node", "--source-method"] };
      },
      async executeInstallationMethod(method) {
        calls.push([...method.argv]);
      },
    });
    const args = ["install", "--scope", "project", "--manifest", "--portable-v1"];
    const dependencies = {
      operations,
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(args, dependencies), 1);
    assert.deepEqual(calls, []);
    assert.equal(sourceMethodReads, 0);
    assert.match(output.join("\\n"), /argv=\["node","--configured-install"\].*cwd=/);
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    await assert.rejects(readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    assert.deepEqual(calls, [["node", "--configured-install"]]);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ methods?: { install?: unknown; update?: unknown }; installation?: unknown }>;
    };
    assert.deepEqual(manifest.skills[0]?.methods, {
      install: { kind: "command", argv: ["node", "--configured-install"], cwd: "tools" },
      update: { kind: "command", argv: ["node", "--configured-update"] },
    });
    assert.deepEqual(manifest.skills[0]?.installation, { path: ".agents/skills/demo", adopted: false });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("preserves configured methods when a project manifest install is a batch", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-method-batch-"));
  try {
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: ["one", "two"].map((name) => ({
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: `portable/${name}`,
        version: { policy: "latest" },
        hosts: ["pi"],
        methods: { update: { kind: "command", argv: ["node", `--update-${name}`] } },
      })),
    }), "utf8");
    const operations = fakeOperations();
    const exitCode = await runCli(["install", "--scope", "project", "--manifest", "--portable-v1", "--yes"], {
      operations,
      projectRoot,
      sourceAccess: {
        async readSkillTree(source, skillPath) {
          assert.equal(source.id, BUILT_IN_SOURCE.id);
          return [{
            path: `${skillPath}/SKILL.md`,
            content: Uint8Array.from(Buffer.from(`## ${path.posix.basename(skillPath)}`)),
            executable: false,
          }];
        },
      },
    });

    assert.equal(exitCode, 0);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ path: string; methods?: { update?: unknown }; installation?: unknown }>;
    };
    assert.deepEqual(manifest.skills.map((skill) => skill.path), ["portable/one", "portable/two"]);
    assert.deepEqual(manifest.skills.map((skill) => skill.methods), [
      { update: { kind: "command", argv: ["node", "--update-one"] } },
      { update: { kind: "command", argv: ["node", "--update-two"] } },
    ]);
    assert.deepEqual(manifest.skills.map((skill) => skill.installation), [
      { path: ".agents/skills/one", adopted: false },
      { path: ".agents/skills/two", adopted: false },
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("previews and executes a source method for user-global installation", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-method-home-"));
  const records: ProjectSkillSelection[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
  try {
    const operations = fakeOperations({
      async readInstallationMethod() {
        return { kind: "command", argv: ["node", "--global-source-method"], cwd: "." };
      },
      async executeInstallationMethod(method, context) {
        calls.push({ argv: method.argv, cwd: path.resolve(context.projectRoot, method.cwd ?? ".") });
      },
      async listUserGlobalInstallations() {
        return records;
      },
      async addUserGlobalInstallation(selection) {
        records.push(selection);
      },
    });
    const args = [
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1",
    ];
    const dependencies = {
      operations,
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(args, dependencies), 1);
    assert.deepEqual(calls, []);
    assert.match(output.join("\\n"), /argv=\["node","--global-source-method"\].*cwd=/);
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(records.length, 0);

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    assert.deepEqual(calls, [{ argv: ["node", "--global-source-method"], cwd: homeDirectory }]);
    assert.equal(records.length, 1);
    assert.deepEqual((records[0] as { installation?: unknown }).installation, {
      path: ".agents/skills/demo",
      adopted: false,
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("configures a user-global install method from direct CLI JSON and persists it only after confirmation", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-configured-method-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-configured-method-state-"));
  const output: string[] = [];
  const errors: string[] = [];
  const calls: string[][] = [];
  let sourceMethodReads = 0;
  try {
    const operations = {
      ...createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") }),
      async readInstallationMethod() {
        sourceMethodReads += 1;
        return { kind: "command", argv: ["node", "--source-method"] };
      },
      async executeInstallationMethod(method: { readonly argv: readonly string[] }) {
        calls.push([...method.argv]);
      },
    };
    const method = JSON.stringify({
      kind: "command",
      argv: ["node", "scripts/install.mjs", "--portable"],
      cwd: "tools",
    });
    const args = [
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--method", method, "--portable-v1",
    ];
    const dependencies = {
      operations,
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(args, dependencies), 1);
    assert.deepEqual(calls, []);
    assert.equal(sourceMethodReads, 0);
    assert.match(output.join("\\n"), /argv=\["node","scripts\/install\.mjs","--portable"\].*cwd=/);
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    await assert.rejects(readFile(path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    assert.deepEqual(calls, [["node", "scripts/install.mjs", "--portable"]]);
    const state = JSON.parse(await readFile(path.join(stateDirectory, "sources.json"), "utf8")) as {
      userGlobalInstallations: Array<{ methods?: unknown }>;
    };
    assert.deepEqual(state.userGlobalInstallations[0]?.methods, {
      install: { kind: "command", argv: ["node", "scripts/install.mjs", "--portable"], cwd: "tools" },
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("rejects direct CLI methods containing credentials or OS-specific executables", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-invalid-method-home-"));
  const errors: string[] = [];
  try {
    const baseArgs = [
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
    ];
    const dependencies = {
      operations: fakeOperations({
        async listUserGlobalInstallations() {
          return [];
        },
        async addUserGlobalInstallation() {
          throw new Error("should not persist an invalid method");
        },
      }),
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli([...baseArgs, "--method", JSON.stringify({ kind: "command", argv: ["node", "--token=secret"] })], dependencies), 1);
    assert.match(errors[0] ?? "", /credential|secret/i);
    assert.equal(await runCli([...baseArgs, "--method", JSON.stringify({ kind: "command", argv: ["node.exe", "scripts/install.mjs"] })], dependencies), 1);
    assert.match(errors[1] ?? "", /safe portable no-shell command name/);
    await assert.rejects(readFile(path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
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

test("rolls back a newly created Claude symlink while preserving an adopted canonical Skill", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-adoption-rollback-"));
  const canonicalPath = path.join(projectRoot, ".agents", "skills", "demo");
  const claudePath = path.join(projectRoot, ".claude", "skills", "demo");
  try {
    try {
      await symlink(canonicalPath, path.join(projectRoot, "symlink-capability-check"), "dir");
      await rm(path.join(projectRoot, "symlink-capability-check"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    await mkdir(canonicalPath, { recursive: true });
    for (const file of cliTree) {
      const relativePath = file.path.slice("portable/demo/".length);
      const destination = path.join(canonicalPath, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content));
    }
    const canonicalBefore = await lstat(canonicalPath);
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
      "--host", "pi,claude", "--version", "latest", "--portable-v1", "--yes", "--confirm-additional-host",
    ], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      projectManifestStore: store,
      stderr: (line) => errors.push(line),
    }), 1);

    assert.match(errors[0] ?? "", /manifest storage unavailable/);
    assert.equal((await lstat(canonicalPath)).ino, canonicalBefore.ino);
    assert.equal(await readFile(path.join(canonicalPath, "SKILL.md"), "utf8"), "## D");
    await assert.rejects(lstat(claudePath), { code: "ENOENT" });
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
      /safe (?:portable )?no-shell command name/,
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
    assert.match(errors[0] ?? "", /executable is not a safe (?:portable )?no-shell command name/);
    await assert.rejects(readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
