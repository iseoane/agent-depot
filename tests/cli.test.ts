import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
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
  type Source,
} from "../src/sources.js";
import { NodeSourceContentAccess, skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import { AGENT_DEPOT_PACKAGE_VERSION, type ProjectSkillSelection } from "../src/project-manifest.js";
import type { ProjectInstallationFileSystem } from "../src/project-installation.js";
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
    "Error: Usage:\n  agent-depot source list\n  agent-depot source add <url>\n  agent-depot source refresh <id> [--yes]\n  agent-depot source remove <id> [--skill <id|path>...] [--all] [--yes]\n  agent-depot source migrate <old-id> <new-id> (--skill <path>... | --all) [--yes]\n  agent-depot discover <source-id> [source-id...]\n  agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--yes] [--confirm-additional-host]\n  agent-depot install --scope project --manifest --portable-v1 [--yes] [--confirm-additional-host]\n  agent-depot update check --scope <project|user-global>\n  agent-depot update apply --scope <project|user-global> (--all | --skill <id|path>...) [--yes] [--confirm-path <relative-path>...]\n  agent-depot uninstall [--skills] [--unmanaged-skill <exact-global-path>...] [--data] [--cli] [--yes]\n  agent-depot tui",
    "Error: The package-owned built-in Source cannot be refreshed or changed",
  ]);
});

test("previews dependent user-global Skills, keeps them by default, and removes only confirmed selections", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-state-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const source = await operations.addGitSource(external.url);
    const kept: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "portable/kept",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/kept", adopted: false },
    };
    const removed: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "portable/removed",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/removed", adopted: true },
    };
    await operations.addUserGlobalInstallation!(kept);
    await operations.addUserGlobalInstallation!(removed);
    await mkdir(path.join(homeDirectory, ".agents", "skills", "kept"), { recursive: true });
    await mkdir(path.join(homeDirectory, ".agents", "skills", "removed"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".agents", "skills", "kept", "SKILL.md"), "kept");
    await writeFile(path.join(homeDirectory, ".agents", "skills", "removed", "SKILL.md"), "removed");

    const dependencies = {
      operations,
      homeDirectory,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    assert.equal(await runCli(["source", "remove", source.id, "--skill", "portable/removed"], dependencies), 1);
    assert.match(output.join("\\n"), /Dependent user-global Skills \(2\)/);
    assert.match(output.join("\\n"), /keep all dependent Skills tracked by default/i);
    assert.match(errors[0] ?? "", /Removal not confirmed/);
    assert.equal((await operations.listSources()).some((candidate) => candidate.id === source.id), true);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "removed", "SKILL.md"), "utf8"), "removed");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli(["source", "remove", source.id, "--skill", "portable/removed", "--yes"], dependencies), 0);
    assert.match(output.join("\\n"), /adopted.*remov/i);
    assert.equal((await operations.listSources()).some((candidate) => candidate.id === source.id), false);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "kept", "SKILL.md"), "utf8"), "kept");
    await assert.rejects(readFile(path.join(homeDirectory, ".agents", "skills", "removed", "SKILL.md")), { code: "ENOENT" });
    assert.deepEqual(await operations.listUserGlobalInstallations!(), [kept]);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("uninstalls independent user-global choices with conservative defaults", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-state-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-project-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const source = await operations.addGitSource(external.url);
    const selection: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
    };
    await operations.addUserGlobalInstallation!(selection);
    const skillFile = path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, "managed", "utf8");
    const manifest = path.join(projectRoot, "agent-depot.json");
    await writeFile(manifest, "project manifest remains", "utf8");
    const dependencies = {
      operations,
      homeDirectory,
      projectRoot,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(["uninstall", "--skills"], dependencies), 1);
    assert.match(errors[0] ?? "", /Uninstall not confirmed/);
    assert.equal(await readFile(skillFile, "utf8"), "managed");
    assert.equal((await operations.listUserGlobalInstallations!()).length, 1);

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli(["uninstall", "--skills", "--yes"], dependencies), 0);
    await assert.rejects(readFile(skillFile), { code: "ENOENT" });
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
    assert.deepEqual(await operations.listSources(), [BUILT_IN_SOURCE, source]);
    assert.equal(await readFile(manifest, "utf8"), "project manifest remains");
    assert.match(output.join("\\n"), /catalog\/configuration data: preserve/i);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("previews and permanently deletes explicitly selected unmanaged user-global Skills", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-unmanaged-remove-home-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const first = path.join(homeDirectory, ".agents", "skills", "first");
    const second = path.join(homeDirectory, ".claude", "skills", "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(path.join(first, "SKILL.md"), "---\nname: first\ndescription: First\n---\n\nFirst\n");
    await writeFile(path.join(second, "SKILL.md"), "---\nname: second\ndescription: Second\n---\n\nSecond\n");
    const operations = fakeOperations({ async listUserGlobalInstallations() { return []; } });
    const dependencies = { operations, homeDirectory, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };

    assert.equal(await runCli(["uninstall", "--unmanaged-skill", first, "--unmanaged-skill", second], dependencies), 1);
    assert.match(errors.join("\\n"), /not confirmed/);
    assert.match(output.join("\\n"), /permanent deletion/i);
    assert.ok(output.join("\\n").includes(first));
    assert.equal((await lstat(first)).isDirectory(), true);
    assert.equal((await lstat(second)).isDirectory(), true);

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli(["uninstall", "--unmanaged-skill", first, "--unmanaged-skill", second, "--yes"], dependencies), 0);
    await assert.rejects(lstat(first), { code: "ENOENT" });
    await assert.rejects(lstat(second), { code: "ENOENT" });
    assert.match(output.join("\\n"), /recovery.*not guaranteed/i);
    assert.match(output.join("\\n"), /Permanently deleted 2 unmanaged/);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("rejects duplicate, traversing, symlink, and managed unmanaged-skill selections", async (t) => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-unmanaged-reject-home-"));
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-unmanaged-reject-outside-"));
  const errors: string[] = [];
  try {
    const candidate = path.join(homeDirectory, ".agents", "skills", "candidate");
    const managed = path.join(homeDirectory, ".agents", "skills", "managed");
    await mkdir(candidate, { recursive: true });
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(candidate, "SKILL.md"), "---\nname: candidate\ndescription: Candidate\n---\n\nCandidate\n");
    await writeFile(path.join(managed, "SKILL.md"), "---\nname: managed\ndescription: Managed\n---\n\nManaged\n");
    const managedSelection: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/managed",
      version: { policy: "latest" },
      hosts: ["pi", "claude"],
      installation: { path: ".agents/skills/managed", adopted: false },
    };
    const operations = fakeOperations({ async listUserGlobalInstallations() { return [managedSelection]; } });
    const run = (args: readonly string[]) => runCli(args, {
      operations,
      homeDirectory,
      stderr: (line) => errors.push(line),
    });

    assert.equal(await run(["uninstall", "--unmanaged-skill", candidate, "--unmanaged-skill", candidate, "--yes"]), 1);
    assert.match(errors.at(-1) ?? "", /Duplicate --unmanaged-skill/);
    assert.equal(await run(["uninstall", "--unmanaged-skill", `${candidate}/../candidate`, "--yes"]), 1);
    assert.match(errors.at(-1) ?? "", /exact normalized absolute/);
    assert.equal(await run(["uninstall", "--unmanaged-skill", managed, "--yes"]), 1);
    assert.match(errors.at(-1) ?? "", /managed/);

    await writeFile(path.join(outside, "SKILL.md"), "outside");
    const linked = path.join(homeDirectory, ".claude", "skills", "linked");
    await mkdir(path.dirname(linked), { recursive: true });
    try {
      await symlink(outside, linked, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    assert.equal(await run(["uninstall", "--unmanaged-skill", linked, "--yes"]), 1);
    assert.match(errors.at(-1) ?? "", /real directory/);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("fails closed when managed records change before unmanaged deletion", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-unmanaged-race-home-"));
  const candidate = path.join(homeDirectory, ".agents", "skills", "candidate");
  const errors: string[] = [];
  try {
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "SKILL.md"), "---\nname: candidate\ndescription: Candidate\n---\n\nCandidate\n");
    const changedSelection: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/other",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/other", adopted: false },
    };
    let reads = 0;
    const operations = fakeOperations({
      async listUserGlobalInstallations() {
        reads += 1;
        return reads === 1 ? [] : [changedSelection];
      },
    });
    assert.equal(await runCli(["uninstall", "--unmanaged-skill", candidate, "--yes"], {
      operations,
      homeDirectory,
      stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors.at(-1) ?? "", /Managed Skill installation records changed/);
    assert.equal((await lstat(candidate)).isDirectory(), true);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("preserves the existing all-managed uninstall flow", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-uninstall-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-uninstall-state-"));
  try {
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const source = await operations.addGitSource(external.url);
    const selection: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "portable/managed",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/managed", adopted: false },
    };
    await operations.addUserGlobalInstallation!(selection);
    await mkdir(path.join(homeDirectory, ".agents", "skills", "managed"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".agents", "skills", "managed", "SKILL.md"), "managed");
    assert.equal(await runCli(["uninstall", "--skills", "--yes"], { operations, homeDirectory }), 0);
    await assert.rejects(lstat(path.join(homeDirectory, ".agents", "skills", "managed")), { code: "ENOENT" });
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("removes every managed user-global Skill and reconciles records in selection order", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-uninstall-multiple-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-uninstall-multiple-state-"));
  try {
    const baseOperations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const first: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/first",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/first", adopted: false },
    };
    const second: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/second",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/second", adopted: false },
    };
    await baseOperations.addUserGlobalInstallation!(first);
    await baseOperations.addUserGlobalInstallation!(second);
    for (const name of ["first", "second"]) {
      const directory = path.join(homeDirectory, ".agents", "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), name, "utf8");
    }
    const removed: string[] = [];
    const operations: SourceOperations = {
      ...baseOperations,
      async removeUserGlobalInstallations(selections) {
        removed.push(...selections.map((selection) => selection.path));
        await baseOperations.removeUserGlobalInstallations!(selections);
      },
    };

    assert.equal(await runCli(["uninstall", "--skills", "--yes"], { operations, homeDirectory }), 0);
    assert.deepEqual(removed, ["portable/first", "portable/second"]);
    await assert.rejects(lstat(path.join(homeDirectory, ".agents", "skills", "first")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(homeDirectory, ".agents", "skills", "second")), { code: "ENOENT" });
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("removes catalog data without deleting retained Skills and only prints CLI handoff", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-data-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-data-state-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-data-project-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const statePath = path.join(stateDirectory, "sources.json");
    const operations = createSourceOperations({ statePath });
    const selection: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
    };
    await operations.addUserGlobalInstallation!(selection);
    const skillFile = path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, "retained", "utf8");
    const manifest = path.join(projectRoot, "agent-depot.json");
    await writeFile(manifest, "project manifest remains", "utf8");
    const dependencies = {
      operations,
      homeDirectory,
      projectRoot,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(["uninstall", "--data"], dependencies), 1);
    assert.match(errors[0] ?? "", /Uninstall not confirmed/);
    assert.equal(await readFile(skillFile, "utf8"), "retained");
    assert.equal(await readFile(statePath, "utf8").then(() => true), true);

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli(["uninstall", "--data", "--yes"], dependencies), 0);
    assert.equal(await readFile(skillFile, "utf8"), "retained");
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    assert.equal(await readFile(manifest, "utf8"), "project manifest remains");
    assert.match(output.join("\\n"), /become untracked/i);

    output.length = 0;
    assert.equal(await runCli(["uninstall", "--cli"], {
      operations,
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }), 0);
    assert.match(output.join("\\n"), /package-manager handoff only/i);
    assert.match(output.join("\\n"), /will not invoke or infer/i);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("reconciles removed Skills before a later combined catalog purge failure", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-partial-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-uninstall-partial-state-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const statePath = path.join(stateDirectory, "sources.json");
    const baseOperations = createSourceOperations({ statePath });
    const selection: ProjectSkillSelection = {
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
    };
    await baseOperations.addUserGlobalInstallation!(selection);
    const skillFile = path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, "managed", "utf8");
    const operations: SourceOperations = {
      ...baseOperations,
      async removeCatalogData() {
        throw new Error("catalog purge failed");
      },
    };

    assert.equal(await runCli(["uninstall", "--skills", "--data", "--yes"], {
      operations,
      homeDirectory,
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors[0] ?? "", /catalog purge failed/);
    await assert.rejects(readFile(skillFile), { code: "ENOENT" });
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
    assert.equal(await readFile(statePath).then(() => true), true);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("rejects conflicting Source removal selection flags in either order", async () => {
  const errors: string[] = [];
  const operations = fakeOperations();
  const argumentSets = [
    ["source", "remove", external.id, "--skill", "portable/demo", "--all", "--yes"],
    ["source", "remove", external.id, "--all", "--skill", "portable/demo", "--yes"],
  ] as const;

  for (const args of argumentSets) {
    errors.length = 0;
    assert.equal(await runCli(args, {
      operations,
      stderr: (line) => errors.push(line),
    }), 1);
    assert.deepEqual(errors, ["Error: source remove cannot combine --all with --skill"]);
  }
});

test("resolves digit-only Source removal Skill paths before numeric indexes", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-digit-path-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-digit-path-state-"));
  try {
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const source = await operations.addGitSource(external.url);
    const indexed: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "portable/index",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/index", adopted: false },
    };
    const digitPath: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "0",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/digit", adopted: false },
    };
    const numericIndex: ProjectSkillSelection = {
      source: { kind: "external", url: source.url },
      path: "portable/fallback",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/fallback", adopted: false },
    };
    await operations.addUserGlobalInstallation!(indexed);
    await operations.addUserGlobalInstallation!(digitPath);
    await operations.addUserGlobalInstallation!(numericIndex);
    await mkdir(path.join(homeDirectory, ".agents", "skills", "index"), { recursive: true });
    await mkdir(path.join(homeDirectory, ".agents", "skills", "digit"), { recursive: true });
    await mkdir(path.join(homeDirectory, ".agents", "skills", "fallback"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".agents", "skills", "index", "SKILL.md"), "indexed");
    await writeFile(path.join(homeDirectory, ".agents", "skills", "digit", "SKILL.md"), "digit path");
    await writeFile(path.join(homeDirectory, ".agents", "skills", "fallback", "SKILL.md"), "numeric index");

    assert.equal(await runCli(["source", "remove", source.id, "--skill", "0", "--skill", "2", "--yes"], {
      operations,
      homeDirectory,
      stdout: () => undefined,
    }), 0);
    assert.deepEqual(await operations.listUserGlobalInstallations!(), [indexed]);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "index", "SKILL.md"), "utf8"), "indexed");
    await assert.rejects(readFile(path.join(homeDirectory, ".agents", "skills", "digit", "SKILL.md")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(homeDirectory, ".agents", "skills", "fallback", "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("refuses Source removal when a dependent Skill path is unsafe without mutating state", async (t) => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-unsafe-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-unsafe-state-"));
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-outside-"));
  const errors: string[] = [];
  try {
    try {
      await symlink(outsideDirectory, path.join(homeDirectory, ".agents"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const source = await operations.addGitSource(external.url);
    await operations.addUserGlobalInstallation!({
      source: { kind: "external", url: source.url },
      path: "portable/unsafe",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/unsafe", adopted: false },
    });
    assert.equal(await runCli(["source", "remove", source.id, "--all", "--yes"], {
      operations,
      homeDirectory,
      stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors[0] ?? "", /symbolic-link|unsafe/i);
    assert.equal((await operations.listSources()).some((candidate) => candidate.id === source.id), true);
    assert.equal((await operations.listUserGlobalInstallations!()).length, 1);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("refuses overlapping selected removal targets before deleting any Skill", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-overlap-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-remove-overlap-state-"));
  const errors: string[] = [];
  try {
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const source = await operations.addGitSource(external.url);
    const records: ProjectSkillSelection[] = [
      {
        source: { kind: "external", url: source.url },
        path: "portable/one",
        version: { policy: "latest" },
        hosts: ["pi"],
        installation: { path: ".agents/skills/shared", adopted: false },
      },
      {
        source: { kind: "external", url: source.url },
        path: "portable/two",
        version: { policy: "latest" },
        hosts: ["pi"],
        installation: { path: ".agents/skills/shared/nested", adopted: false },
      },
    ];
    for (const record of records) await operations.addUserGlobalInstallation!(record);
    await mkdir(path.join(homeDirectory, ".agents", "skills", "shared", "nested"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".agents", "skills", "shared", "SKILL.md"), "one", "utf8");
    await writeFile(path.join(homeDirectory, ".agents", "skills", "shared", "nested", "SKILL.md"), "two", "utf8");

    assert.equal(await runCli(["source", "remove", source.id, "--all", "--yes"], {
      operations,
      homeDirectory,
      stderr: (line) => errors.push(line),
    }), 1);
    assert.match(errors[0] ?? "", /overlap/u);
    assert.equal((await operations.listSources()).some((candidate) => candidate.id === source.id), true);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "shared", "SKILL.md"), "utf8"), "one");
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "shared", "nested", "SKILL.md"), "utf8"), "two");
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
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

test("discovers boolean-frontmatter candidates without reading metadata or executing commands", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-discover-boolean-state-"));
  const builtInRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-discover-boolean-builtin-"));
  const output: string[] = [];
  const readPaths: string[] = [];
  const markerPath = path.join(builtInRoot, "command-ran");
  try {
    const skillDirectory = path.join(builtInRoot, "portable", "discoverable");
    await mkdir(path.join(skillDirectory, "scripts"), { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), [
      "---",
      "name: Discoverable",
      "description: A discoverable skill",
      "disable-model-invocation: true",
      "---",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(skillDirectory, "agent-depot-method.json"), JSON.stringify({
      kind: "command",
      argv: ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
    }), "utf8");
    await writeFile(path.join(skillDirectory, "scripts", "run.sh"), `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\n`, "utf8");

    const sourceContentAccess = new NodeSourceContentAccess({
      builtInRoot,
      readFile: async (filePath) => {
        readPaths.push(filePath);
        assert.equal(path.basename(filePath), "SKILL.md", "discovery must not read installation metadata or commands");
        return readFile(filePath, "utf8");
      },
    });
    const operations = createSourceOperations({
      statePath: path.join(stateDirectory, "sources.json"),
      sourceContentAccess,
    });
    const exitCode = await runCli(["discover", BUILT_IN_SOURCE.id], {
      operations,
      stdout: (line) => output.push(line),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(output, [
      `Candidate: ${BUILT_IN_SOURCE.id}\tportable/discoverable\tDiscoverable\tA discoverable skill`,
    ]);
    assert.deepEqual(readPaths, [path.join(skillDirectory, "SKILL.md")]);
    await assert.rejects(readFile(markerPath), { code: "ENOENT" });
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
const cliBaseline = skillTreeBaseline(cliTree);
const cliResolvedVersion = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };

function cliSourceAccess(tree: readonly SkillTreeFile[] = cliTree) {
  return {
    async readSkillTree(source: typeof BUILT_IN_SOURCE, skillPath: string) {
      assert.equal(source.id, BUILT_IN_SOURCE.id);
      assert.equal(skillPath, "portable/demo");
      return tree;
    },
    async readSkillTreeSnapshot(source: typeof BUILT_IN_SOURCE, skillPath: string) {
      assert.equal(source.id, BUILT_IN_SOURCE.id);
      assert.equal(skillPath, "portable/demo");
      return { files: tree, resolvedVersion: cliResolvedVersion };
    },
  };
}

test("previews and explicitly migrates user-global identities without moving files or writing manifests", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-migrate-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-migrate-state-"));
  const output: string[] = [];
  const errors: string[] = [];
  const oldCommit = "a".repeat(40);
  const newCommit = "b".repeat(40);
  try {
    const sourceAccess = {
      async readSnapshot() { return []; },
      async readSkillTreeSnapshot(source: Source, skillPath: string) {
        assert.equal(skillPath, "portable/demo");
        assert.equal(source.kind, "git");
        return {
          files: cliTree,
          resolvedVersion: { kind: "git-commit" as const, commit: source.url.includes("new-migration") ? newCommit : oldCommit },
        };
      },
    };
    const operations = createSourceOperations({
      statePath: path.join(stateDirectory, "sources.json"),
      sourceContentAccess: sourceAccess,
    });
    const oldSource = await operations.addGitSource("https://github.com/example/old-migration.git");
    const newSource = await operations.addGitSource("https://github.com/example/new-migration.git");
    const selection: ProjectSkillSelection = {
      source: { kind: "external", url: oldSource.url },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: {
        path: ".agents/skills/demo",
        adopted: true,
        resolvedVersion: { kind: "git-commit", commit: oldCommit },
        baseline: skillTreeBaseline(cliTree),
      },
    };
    await operations.addUserGlobalInstallation!(selection);
    const skillFile = path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md");
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, "unchanged", "utf8");
    const dependencies = {
      operations,
      homeDirectory,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const args = ["source", "migrate", oldSource.id, newSource.id, "--skill", "portable/demo"];
    assert.equal(await runCli(args, dependencies), 1);
    assert.match(errors[0] ?? "", /Migration not confirmed/);
    assert.deepEqual((await operations.listUserGlobalInstallations!())[0]?.source, { kind: "external", url: oldSource.url });
    assert.equal(await readFile(skillFile, "utf8"), "unchanged");

    errors.length = 0;
    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    assert.deepEqual((await operations.listUserGlobalInstallations!())[0], {
      ...selection,
      source: { kind: "external", url: newSource.url },
      installation: {
        ...selection.installation,
        resolvedVersion: { kind: "git-commit", commit: newCommit },
      },
    });
    assert.equal(await readFile(skillFile, "utf8"), "unchanged");
    await assert.rejects(readFile(path.join(homeDirectory, "agent-depot.json")), { code: "ENOENT" });
    assert.match(output.join("\\n"), /no files or project manifests are changed/);
    assert.deepEqual(errors, []);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

function injectedUpdateFileSystem(
  calls: string[],
  scopeRoot?: string,
  adapterRoot?: string,
): ProjectInstallationFileSystem {
  const mapPath = (candidate: string): string => {
    if (scopeRoot === undefined || adapterRoot === undefined) return candidate;
    const relative = path.relative(path.resolve(scopeRoot), path.resolve(candidate));
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return path.join(adapterRoot, relative);
    }
    return candidate;
  };
  return {
    lstat: async (candidate) => {
      calls.push(`lstat:${candidate}`);
      return lstat(mapPath(candidate));
    },
    readdir: async (candidate) => {
      calls.push(`readdir:${candidate}`);
      return readdir(mapPath(candidate));
    },
    readFile: async (candidate) => {
      calls.push(`readFile:${candidate}`);
      return readFile(mapPath(candidate));
    },
    mkdir: async (candidate) => {
      calls.push(`mkdir:${candidate}`);
      await mkdir(mapPath(candidate));
    },
    writeFile: async (candidate, content) => {
      calls.push(`writeFile:${candidate}`);
      await writeFile(mapPath(candidate), content, { flag: "wx" });
    },
    chmod: async (candidate, mode) => {
      calls.push(`chmod:${candidate}`);
      await chmod(mapPath(candidate), mode);
    },
    symlink: async (target, candidate, type) => {
      calls.push(`symlink:${candidate}`);
      await symlink(mapPath(target), mapPath(candidate), type);
    },
    readlink: async (candidate) => {
      calls.push(`readlink:${candidate}`);
      return readlink(mapPath(candidate));
    },
    rename: async (from, to) => {
      calls.push(`rename:${from}:${to}`);
      await rename(mapPath(from), mapPath(to));
    },
    rm: async (candidate) => {
      calls.push(`rm:${candidate}`);
      await rm(mapPath(candidate), { recursive: true, force: true });
    },
    rmdir: async (candidate) => {
      calls.push(`rmdir:${candidate}`);
      await rmdir(mapPath(candidate));
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
      installation: {
        path: ".agents/skills/demo",
        adopted: false,
        resolvedVersion: cliResolvedVersion,
        baseline: cliBaseline,
      },
    });
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    assert.equal(errors.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("classifies project collisions before confirmation and never overwrites without the future flag", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-project-collision-"));
  const target = path.join(projectRoot, ".agents", "skills", "demo");
  const output: string[] = [];
  const errors: string[] = [];
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "locally owned", "utf8");
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const args = [
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1",
    ];

    assert.equal(await runCli(args, dependencies), 1);
    assert.ok(output.some((line) => line.includes(`target: ${target}`)));
    assert.ok(output.some((line) => /COLLISION:.*content-mismatch/i.test(line)));
    assert.ok(output.some((line) => /collision handling: fail-closed; no path will be changed/i.test(line)));
    assert.ok(output.some((line) => /no --yes supplied; zero files or installation state will be changed/i.test(line)));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli([...args, "--overwrite"], dependencies), 1);
    assert.ok(output.some((line) => /fail-closed; no path will be changed without --yes/i.test(line)));
    assert.ok(output.some((line) => /if confirmed: old Skill would be moved to a retained backup at .*\.agent-depot-backup-<generated-suffix>/i.test(line)));
    assert.ok(output.some((line) => /no --yes supplied; zero files or installation state will be changed/i.test(line)));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli([...args, "--yes"], dependencies), 1);
    assert.match(errors[0] ?? "", /content-mismatch.*--overwrite --yes/i);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli([...args, "--overwrite", "--yes"], dependencies), 0);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "## D");
    const installedOutput = output.join("\n");
    assert.match(installedOutput, /target will be replaced because --overwrite --yes was supplied/i);
    assert.match(installedOutput, /overwrite backup: old Skill will be moved to a retained backup at .*\.agent-depot-backup-<generated-suffix>/i);
    assert.match(installedOutput, /replace the colliding target .* retain a backup of the existing Skill .* install the selected source files/i);
    assert.match(installedOutput, /SKILL\.md .* install into the replacement target/i);
    assert.doesNotMatch(installedOutput, /adopt identical files|create missing files|refuse conflicts|adopt if identical|create if missing/i);
    const backupMatch = installedOutput.match(/Persistent backup retained at (.+)$/m);
    assert.ok(backupMatch?.[1]);
    assert.equal(await readFile(path.join(backupMatch![1]!, "SKILL.md"), "utf8"), "locally owned");
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as { skills: unknown[] };
    assert.equal(manifest.skills.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("refuses overwrite of a path managed by another selection in both scopes", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-overlap-project-"));
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-overlap-home-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-managed-overlap-state-"));
  try {
    const target = path.join(projectRoot, ".agents", "skills", "demo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "managed owner", "utf8");
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{
        source: { kind: "external", url: external.url },
        path: "other/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
        installation: { path: ".agents/skills/demo", adopted: false },
      }],
    }), "utf8");
    const projectErrors: string[] = [];
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--overwrite", "--yes",
    ], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => projectErrors.push(line),
    }), 1);
    assert.match(projectErrors[0] ?? "", /overlaps the managed installation.*another Source\/Skill selection/i);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "managed owner");

    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    await operations.addUserGlobalInstallation!({
      source: { kind: "external", url: external.url },
      path: "other/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: { path: ".agents/skills/demo", adopted: false },
    });
    const globalTarget = path.join(homeDirectory, ".agents", "skills", "demo");
    await mkdir(globalTarget, { recursive: true });
    await writeFile(path.join(globalTarget, "SKILL.md"), "managed owner", "utf8");
    const globalErrors: string[] = [];
    assert.equal(await runCli([
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--overwrite", "--yes",
    ], {
      operations,
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => globalErrors.push(line),
    }), 1);
    assert.match(globalErrors[0] ?? "", /overlaps the managed installation.*another Source\/Skill selection/i);
    assert.equal(await readFile(path.join(globalTarget, "SKILL.md"), "utf8"), "managed owner");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("rejects an incompatible Git Skill tree before asking for confirmation", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-git-incompatible-"));
  const output: string[] = [];
  const errors: string[] = [];
  const incompatibleTree: readonly SkillTreeFile[] = [
    ...cliTree,
    { path: "portable/demo/.claude/settings.json", content: Buffer.from("host-specific"), executable: false },
  ];
  try {
    const sourceAccess = {
      async readSkillTree(source: Source, skillPath: string) {
        assert.equal(source.id, external.id);
        assert.equal(skillPath, "portable/demo");
        return incompatibleTree;
      },
      async readSkillTreeSnapshot(source: Source, skillPath: string) {
        assert.equal(source.id, external.id);
        assert.equal(skillPath, "portable/demo");
        return {
          files: incompatibleTree,
          resolvedVersion: { kind: "git-commit" as const, commit: "a".repeat(40) },
        };
      },
    };
    const args = [
      "install", "--scope", "project", "--source", external.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1",
    ];

    assert.equal(await runCli(args, {
      operations: fakeOperations({ resolveProjectSource: async () => external }),
      projectRoot,
      sourceAccess,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    }), 1);
    assert.deepEqual(output, []);
    assert.deepEqual(errors, [
      'Error: Skill "demo" contains ".claude/settings.json", which is excluded by the portable V1 format rules',
    ]);
    await assert.rejects(readFile(path.join(projectRoot, "agent-depot.json")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("previews and installs skill-relative agents support files as portable content", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-agents-support-"));
  const output: string[] = [];
  const errors: string[] = [];
  const agentsTree: readonly SkillTreeFile[] = [
    ...cliTree,
    { path: "portable/demo/agents/openai.yaml", content: Buffer.from("model = gpt-4.1\\n"), executable: false },
  ];
  try {
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(agentsTree),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const args = [
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1",
    ];

    assert.equal(await runCli(args, dependencies), 1);
    assert.ok(output.some((line) => line.includes("portable/demo/agents/openai.yaml")));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(errors.some((line) => /incompatible|excluded by the portable/i.test(line)), false);

    assert.equal(await runCli([...args, "--yes"], dependencies), 0);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "agents", "openai.yaml"), "utf8"), "model = gpt-4.1\\n");
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
      resolvedVersion: cliResolvedVersion,
      baseline: cliBaseline,
    });
    const sharedOperations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    assert.ok(sharedOperations.listUserGlobalInstallations);
    assert.equal((await sharedOperations.listUserGlobalInstallations()).length, 1);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("classifies user-global collisions at the injected home before confirmation and retains the backup", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-collision-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-global-collision-state-"));
  const target = path.join(homeDirectory, ".agents", "skills", "demo");
  const output: string[] = [];
  const errors: string[] = [];
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "locally owned", "utf8");
    const dependencies = {
      operations: createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") }),
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const args = [
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1",
    ];

    assert.equal(await runCli(args, dependencies), 1);
    assert.ok(output.some((line) => line.includes(`target: ${target}`)));
    assert.ok(output.some((line) => /COLLISION:.*content-mismatch/i.test(line)));
    assert.ok(output.some((line) => /collision handling: fail-closed; no path will be changed/i.test(line)));
    assert.ok(output.some((line) => /no --yes supplied; zero files or installation state will be changed/i.test(line)));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli([...args, "--overwrite"], dependencies), 1);
    assert.ok(output.some((line) => /fail-closed; no path will be changed without --yes/i.test(line)));
    assert.ok(output.some((line) => /if confirmed: old Skill would be moved to a retained backup at .*\.agent-depot-backup-<generated-suffix>/i.test(line)));
    assert.ok(output.some((line) => /no --yes supplied; zero files or installation state will be changed/i.test(line)));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli([...args, "--yes"], dependencies), 1);
    assert.match(errors[0] ?? "", /content-mismatch.*--overwrite --yes/i);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli([...args, "--overwrite", "--yes"], dependencies), 0);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "## D");
    const installedOutput = output.join("\n");
    assert.match(installedOutput, /target will be replaced because --overwrite --yes was supplied/i);
    assert.match(installedOutput, /overwrite backup: old Skill will be moved to a retained backup at .*\.agent-depot-backup-<generated-suffix>/i);
    const backupMatch = installedOutput.match(/Persistent backup retained at (.+)$/m);
    assert.ok(backupMatch?.[1]);
    assert.equal(await readFile(path.join(backupMatch![1]!, "SKILL.md"), "utf8"), "locally owned");
    assert.equal((await dependencies.operations.listUserGlobalInstallations!()).length, 1);
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
      resolvedVersion: cliResolvedVersion,
      baseline: cliBaseline,
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
      resolvedVersion: cliResolvedVersion,
      baseline: cliBaseline,
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

test("rejects manifest selections with the same physical basename before confirmation", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-manifest-collision-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: ["one", "two"].map((name) => ({
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: `portable/${name}/demo`,
        version: { policy: "latest" },
        hosts: ["pi"],
      })),
    }), "utf8");
    const exitCode = await runCli(["install", "--scope", "project", "--manifest", "--portable-v1", "--yes"], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: {
        async readSkillTree(_source, skillPath) {
          return [{
            path: `${skillPath}/SKILL.md`,
            content: Uint8Array.from(Buffer.from("## D")),
            executable: false,
          }];
        },
      },
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });

    assert.equal(exitCode, 1);
    assert.match(errors[0] ?? "", /same physical installation target/);
    assert.deepEqual(output, []);
    await assert.rejects(readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as { skills: unknown[] };
    assert.equal(manifest.skills.length, 2);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("previews collisions for each manifest selection before confirmation", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-manifest-preview-collision-"));
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const target = path.join(projectRoot, ".agents", "skills", "demo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "locally owned", "utf8");
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: "portable/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
      }],
    }), "utf8");

    assert.equal(await runCli(["install", "--scope", "project", "--manifest", "--portable-v1"], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    }), 1);
    assert.ok(output.some((line) => /COLLISION:.*content-mismatch/i.test(line)));
    assert.match(errors[0] ?? "", /Installation not confirmed/);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "locally owned");
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
    assert.deepEqual(manifest.skills[0]?.installation, {
      path: ".agents/skills/demo",
      adopted: false,
      resolvedVersion: cliResolvedVersion,
      baseline: cliBaseline,
    });
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
    const installations = manifest.skills.map((skill) => skill.installation as {
      path: string;
      adopted: boolean;
      resolvedVersion?: unknown;
      baseline?: unknown;
    });
    assert.deepEqual(installations.map(({ path: installationPath, adopted }) => ({ path: installationPath, adopted })), [
      { path: ".agents/skills/one", adopted: false },
      { path: ".agents/skills/two", adopted: false },
    ]);
    assert.deepEqual(installations.map(({ resolvedVersion }) => resolvedVersion), [cliResolvedVersion, cliResolvedVersion]);
    assert.ok(installations.every(({ baseline }) => baseline && typeof baseline === "object"));
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
      resolvedVersion: cliResolvedVersion,
      baseline: cliBaseline,
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

test("rolls back the original tree when overwrite persistence fails in both scopes", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-overwrite-manifest-rollback-"));
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-overwrite-global-rollback-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-overwrite-global-state-"));
  try {
    const makeExisting = async (root: string) => {
      const target = path.join(root, ".agents", "skills", "demo");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), "locally owned", "utf8");
      return target;
    };
    const projectTarget = await makeExisting(projectRoot);
    const projectErrors: string[] = [];
    const manifestStore = {
      path: path.join(projectRoot, "agent-depot.json"),
      async load() { return { version: 1 as const, skills: [] as const }; },
      async save() { throw new Error("manifest overwrite save failed"); },
    };
    assert.equal(await runCli([
      "install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--overwrite", "--yes",
    ], {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: cliSourceAccess(),
      projectManifestStore: manifestStore,
      stderr: (line) => projectErrors.push(line),
    }), 1);
    assert.match(projectErrors[0] ?? "", /manifest overwrite save failed/);
    assert.equal(await readFile(path.join(projectTarget, "SKILL.md"), "utf8"), "locally owned");

    const globalTarget = await makeExisting(homeDirectory);
    const globalErrors: string[] = [];
    const operations = createSourceOperations({ statePath: path.join(stateDirectory, "sources.json") });
    const failingOperations = {
      ...operations,
      async addUserGlobalInstallation() { throw new Error("global state overwrite save failed"); },
    };
    assert.equal(await runCli([
      "install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1", "--overwrite", "--yes",
    ], {
      operations: failingOperations,
      homeDirectory,
      sourceAccess: cliSourceAccess(),
      stderr: (line) => globalErrors.push(line),
    }), 1);
    assert.match(globalErrors[0] ?? "", /global state overwrite save failed/);
    assert.equal(await readFile(path.join(globalTarget, "SKILL.md"), "utf8"), "locally owned");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
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

test("reports user-global unmanaged Skill locations separately without resolving them as Sources", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-global-unmanaged-home-"));
  const output: string[] = [];
  const sourceReads: string[] = [];
  const managedTree: readonly SkillTreeFile[] = [
    { path: "portable/managed/SKILL.md", content: Buffer.from("managed"), executable: false },
  ];
  const managed: ProjectSkillSelection = {
    source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
    path: "portable/managed",
    version: { policy: "latest" },
    hosts: ["pi"],
    installation: {
      path: ".agents/skills/managed",
      adopted: false,
      resolvedVersion: { kind: "builtin-package", version: "0.1.0" },
      baseline: skillTreeBaseline(managedTree),
    },
  };
  try {
    await mkdir(path.join(homeDirectory, ".agents", "skills", "managed"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".agents", "skills", "managed", "SKILL.md"), "---\nname: managed\ndescription: Managed\n---\n\nManaged\n");
    await mkdir(path.join(homeDirectory, ".agents", "skills", "unmanaged"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".agents", "skills", "unmanaged", "SKILL.md"), "---\nname: unmanaged\ndescription: Unmanaged\n---\n\nUnmanaged\n");
    await mkdir(path.join(homeDirectory, ".claude", "skills", "claude-unmanaged"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".claude", "skills", "claude-unmanaged", "SKILL.md"), "---\nname: claude-unmanaged\ndescription: Claude unmanaged\n---\n\nUnmanaged\n");
    await mkdir(path.join(homeDirectory, ".agents", "skills", "unsafe", "SKILL.md"), { recursive: true });

    const exitCode = await runCli(["update", "check", "--scope", "user-global"], {
      operations: fakeOperations({
        async listUserGlobalInstallations() {
          return [managed];
        },
      }),
      homeDirectory,
      sourceAccess: {
        async readSkillTree() {
          throw new Error("the update check must use the snapshot reader");
        },
        async readSkillTreeSnapshot(_source, skillPath) {
          sourceReads.push(skillPath);
          assert.equal(skillPath, managed.path);
          return { files: managedTree, resolvedVersion: managed.installation?.resolvedVersion };
        },
      },
      stdout: (line) => output.push(line),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(sourceReads, ["portable/managed"]);
    assert.match(output.join("\\n"), /Current \(1\)/);
    assert.match(output.join("\\n"), /Unmanaged \(2\):/);
    assert.ok(output.includes(`  ${path.join(homeDirectory, ".agents", "skills", "unmanaged")}`));
    assert.ok(output.includes(`  ${path.join(homeDirectory, ".claude", "skills", "claude-unmanaged")}`));
    assert.match(output.join("\\n"), /Skipped\/unsafe entries \(1\):/);
    assert.ok(output.includes(`  ${path.join(homeDirectory, ".agents", "skills", "unsafe")}: SKILL.md is not a real file`));
    assert.match(output.join("\\n"), /not Unmanaged entries or removal candidates/);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("selects one project update by numeric index and writes only through the injected filesystem", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-project-"));
  const adapterRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-project-adapter-"));
  const output: string[] = [];
  const errors: string[] = [];
  const filesystemCalls: string[] = [];
  const fileSystem = injectedUpdateFileSystem(filesystemCalls, projectRoot, adapterRoot);
  const oldTrees: Record<string, readonly SkillTreeFile[]> = {
    "portable/demo": [{ path: "portable/demo/SKILL.md", content: Buffer.from("demo-old"), executable: false }],
    "portable/other": [{ path: "portable/other/SKILL.md", content: Buffer.from("other-old"), executable: false }],
  };
  const newTrees: Record<string, readonly SkillTreeFile[]> = {
    "portable/demo": [{ path: "portable/demo/SKILL.md", content: Buffer.from("demo-new"), executable: false }],
    "portable/other": [{ path: "portable/other/SKILL.md", content: Buffer.from("other-new"), executable: false }],
  };
  const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
  const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };
  const installations = [
    { sourcePath: "portable/demo", installPath: ".agents/skills/demo", content: "demo-old" },
    { sourcePath: "portable/other", installPath: ".agents/skills/other", content: "other-old" },
  ];
  try {
    for (const root of [projectRoot, adapterRoot]) {
      for (const installation of installations) {
        const target = path.join(root, installation.installPath);
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "SKILL.md"), installation.content);
      }
    }
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: installations.map((installation) => ({
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: installation.sourcePath,
        version: { policy: "latest" },
        hosts: ["pi"],
        installation: {
          path: installation.installPath,
          adopted: false,
          resolvedVersion: oldVersion,
          baseline: skillTreeBaseline(oldTrees[installation.sourcePath]!),
        },
      })),
    }), "utf8");
    const readTree = (trees: Record<string, readonly SkillTreeFile[]>, skillPath: string): readonly SkillTreeFile[] => {
      const tree = trees[skillPath];
      if (!tree) throw new Error(`Unexpected Skill path: ${skillPath}`);
      return tree;
    };
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: {
        async readSkillTree(_source: typeof BUILT_IN_SOURCE, skillPath: string) {
          return readTree(newTrees, skillPath);
        },
        async readSkillTreeSnapshot(_source: typeof BUILT_IN_SOURCE, skillPath: string) {
          return { files: readTree(newTrees, skillPath), resolvedVersion: newVersion };
        },
      },
      installationOptions: { fileSystem },
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(["update", "check", "--scope", "project"], dependencies), 0);
    assert.match(output.join("\\n"), /Updateable \(2\)/);
    assert.match(output.join("\\n"), /Current \(0\)/);
    assert.match(output.join("\\n"), /Unknown \(0\)/);

    output.length = 0;
    assert.equal(await runCli(["update", "apply", "--scope", "project", "--skill", "1", "--yes"], dependencies), 0);
    assert.match(output.join("\\n"), /Update summary: 1 updated, 0 failed/);
    assert.ok(filesystemCalls.some((call) => call.startsWith("writeFile:")), "the injected filesystem must write staged files");
    assert.ok(filesystemCalls.filter((call) => call.startsWith("rename:")).length >= 2, "the injected filesystem must perform atomic renames");

    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "demo-old");
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "other", "SKILL.md"), "utf8"), "other-old");
    assert.equal(await readFile(path.join(adapterRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "demo-old");
    assert.equal(await readFile(path.join(adapterRoot, ".agents", "skills", "other", "SKILL.md"), "utf8"), "other-new");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(adapterRoot, { recursive: true, force: true });
  }
});

test("displays unknown versions separately and excludes them from CLI batch updates", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-unknown-"));
  const output: string[] = [];
  const errors: string[] = [];
  const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
  const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };
  const oldTrees: Record<string, readonly SkillTreeFile[]> = {
    "portable/demo": [{ path: "portable/demo/SKILL.md", content: Buffer.from("demo-old"), executable: false }],
    "portable/legacy": [{ path: "portable/legacy/SKILL.md", content: Buffer.from("legacy-old"), executable: false }],
  };
  const newTrees: Record<string, readonly SkillTreeFile[]> = {
    "portable/demo": [{ path: "portable/demo/SKILL.md", content: Buffer.from("demo-new"), executable: false }],
    "portable/legacy": [{ path: "portable/legacy/SKILL.md", content: Buffer.from("legacy-new"), executable: false }],
  };
  const installations = [
    { sourcePath: "portable/demo", installPath: ".agents/skills/demo", resolvedVersion: oldVersion },
    { sourcePath: "portable/legacy", installPath: ".agents/skills/legacy", resolvedVersion: undefined },
  ];
  try {
    for (const installation of installations) {
      const target = path.join(projectRoot, installation.installPath);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), installation.sourcePath === "portable/demo" ? "demo-old" : "legacy-old");
    }
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: installations.map((installation) => ({
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: installation.sourcePath,
        version: { policy: "latest" },
        hosts: ["pi"],
        installation: {
          path: installation.installPath,
          adopted: false,
          ...(installation.resolvedVersion === undefined ? {} : { resolvedVersion: installation.resolvedVersion }),
          baseline: skillTreeBaseline(oldTrees[installation.sourcePath]!),
        },
      })),
    }), "utf8");
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: {
        async readSkillTree(_source: typeof BUILT_IN_SOURCE, skillPath: string) {
          const tree = newTrees[skillPath];
          if (!tree) throw new Error(`Unexpected Skill path: ${skillPath}`);
          return tree;
        },
        async readSkillTreeSnapshot(_source: typeof BUILT_IN_SOURCE, skillPath: string) {
          const tree = newTrees[skillPath];
          if (!tree) throw new Error(`Unexpected Skill path: ${skillPath}`);
          return {
            files: tree,
            ...(skillPath === "portable/demo" ? { resolvedVersion: newVersion } : {}),
          };
        },
      },
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(["update", "check", "--scope", "project"], dependencies), 0);
    const unknownHeader = output.findIndex((line) => line === "Unknown (1):");
    assert.ok(unknownHeader >= 0, "unknown versions must have their own section");
    assert.match(output[unknownHeader + 1] ?? "", /path=portable\/legacy/);
    assert.match(output.join("\\n"), /Updateable \(1\)/);

    errors.length = 0;
    assert.equal(await runCli(["update", "apply", "--scope", "project", "--skill", "1", "--yes"], dependencies), 1);
    assert.match(errors.join("\\n"), /unknown version status and is not updateable/);

    output.length = 0;
    assert.equal(await runCli(["update", "apply", "--scope", "project", "--all", "--yes"], dependencies), 0);
    assert.match(output.join("\\n"), /Update summary: 1 updated, 0 failed/);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "demo-new");
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "legacy", "SKILL.md"), "utf8"), "legacy-old");

    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ path: string; installation?: { resolvedVersion?: unknown; baseline?: unknown } }>;
    };
    assert.deepEqual(manifest.skills.find((skill) => skill.path === "portable/demo")?.installation, {
      path: ".agents/skills/demo",
      adopted: false,
      resolvedVersion: newVersion,
      baseline: skillTreeBaseline(newTrees["portable/demo"]!),
    });
    assert.equal(manifest.skills.find((skill) => skill.path === "portable/legacy")?.installation?.resolvedVersion, undefined);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("continues after one selected CLI update fails and reports the failed and successful Skills", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-failure-"));
  const output: string[] = [];
  const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
  const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };
  const oldTrees: Record<string, readonly SkillTreeFile[]> = {
    "portable/failing": [{ path: "portable/failing/SKILL.md", content: Buffer.from("failing-old"), executable: false }],
    "portable/succeeding": [{ path: "portable/succeeding/SKILL.md", content: Buffer.from("succeeding-old"), executable: false }],
  };
  const newTrees: Record<string, readonly SkillTreeFile[]> = {
    "portable/failing": [{ path: "portable/failing/SKILL.md", content: Buffer.from("failing-new"), executable: false }],
    "portable/succeeding": [{ path: "portable/succeeding/SKILL.md", content: Buffer.from("succeeding-new"), executable: false }],
  };
  const installations = [
    { sourcePath: "portable/failing", installPath: ".agents/skills/failing", method: true },
    { sourcePath: "portable/succeeding", installPath: ".agents/skills/succeeding", method: false },
  ];
  try {
    for (const installation of installations) {
      const target = path.join(projectRoot, installation.installPath);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), `${installation.sourcePath.split("/")[1]}-old`);
    }
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: installations.map((installation) => ({
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: installation.sourcePath,
        version: { policy: "latest" },
        hosts: ["pi"],
        ...(installation.method ? { methods: { update: { kind: "command", argv: ["node", "fail-update"] } } } : {}),
        installation: {
          path: installation.installPath,
          adopted: false,
          resolvedVersion: oldVersion,
          baseline: skillTreeBaseline(oldTrees[installation.sourcePath]!),
        },
      })),
    }), "utf8");
    const operations = fakeOperations({
      async executeInstallationMethod(_method, context) {
        if (context.skillPath === "portable/failing") throw new Error("intentional update failure");
      },
    });
    const dependencies = {
      operations,
      projectRoot,
      sourceAccess: {
        async readSkillTree(_source: typeof BUILT_IN_SOURCE, skillPath: string) {
          const tree = newTrees[skillPath];
          if (!tree) throw new Error(`Unexpected Skill path: ${skillPath}`);
          return tree;
        },
        async readSkillTreeSnapshot(_source: typeof BUILT_IN_SOURCE, skillPath: string) {
          const tree = newTrees[skillPath];
          if (!tree) throw new Error(`Unexpected Skill path: ${skillPath}`);
          return { files: tree, resolvedVersion: newVersion };
        },
      },
      stdout: (line: string) => output.push(line),
    };

    assert.equal(await runCli(["update", "apply", "--scope", "project", "--all", "--yes"], dependencies), 1);
    assert.match(output.join("\\n"), /Updated Skill "portable\/succeeding"/);
    assert.match(output.join("\\n"), /Failed Skill "portable\/failing".*intentional update failure/);
    assert.match(output.join("\\n"), /Update summary: 1 updated, 1 failed/);
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "failing", "SKILL.md"), "utf8"), "failing-old");
    assert.equal(await readFile(path.join(projectRoot, ".agents", "skills", "succeeding", "SKILL.md"), "utf8"), "succeeding-new");

    const manifest = JSON.parse(await readFile(path.join(projectRoot, "agent-depot.json"), "utf8")) as {
      skills: Array<{ path: string; installation?: { resolvedVersion?: unknown; baseline?: unknown } }>;
    };
    assert.deepEqual(manifest.skills.find((skill) => skill.path === "portable/succeeding")?.installation, {
      path: ".agents/skills/succeeding",
      adopted: false,
      resolvedVersion: newVersion,
      baseline: skillTreeBaseline(newTrees["portable/succeeding"]!),
    });
    assert.deepEqual(manifest.skills.find((skill) => skill.path === "portable/failing")?.installation?.resolvedVersion, oldVersion);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("reports a failed update preview per Skill, applies nothing and exits 1 when the update tree is unsafe", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-preview-failed-"));
  const output: string[] = [];
  const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
  const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };
  const oldTree: readonly SkillTreeFile[] = [{ path: "portable/demo/SKILL.md", content: Buffer.from("old"), executable: false }];
  const newTree: readonly SkillTreeFile[] = [
    { path: "portable/demo/SKILL.md", content: Buffer.from("new"), executable: false },
    { path: "portable/demo/../escape.txt", content: Buffer.from("escape"), executable: false },
  ];
  try {
    const target = path.join(projectRoot, ".agents", "skills", "demo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "old");
    await writeFile(path.join(projectRoot, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{
        source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
        path: "portable/demo",
        version: { policy: "latest" },
        hosts: ["pi"],
        installation: {
          path: ".agents/skills/demo",
          adopted: false,
          resolvedVersion: oldVersion,
          baseline: skillTreeBaseline(oldTree),
        },
      }],
    }), "utf8");
    // The assessment only compares snapshots; the preview validates every tree
    // path, so an unsafe path in the new tree makes the preview (and only it) fail.
    const dependencies = {
      operations: fakeOperations(),
      projectRoot,
      sourceAccess: {
        async readSkillTree() {
          return newTree;
        },
        async readSkillTreeSnapshot() {
          return { files: newTree, resolvedVersion: newVersion };
        },
      },
      stdout: (line: string) => output.push(line),
    };

    assert.equal(await runCli(["update", "apply", "--scope", "project", "--all", "--yes"], dependencies), 1);
    const rendered = output.join("\n");
    const itemId = JSON.stringify(JSON.stringify([{ kind: "builtin", id: BUILT_IN_SOURCE.id }, "portable/demo"]));
    assert.ok(
      output.includes(`Preview failed for ${itemId}: Skill "demo" returned an unsafe or duplicate file path: "portable/demo/../escape.txt"`),
    );
    assert.match(rendered, /Failed Skill "portable\/demo".*unsafe or duplicate file path/);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "old");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("checks and applies user-global updates with an external method preview through the injected filesystem", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-global-"));
  const adapterRoot = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-update-global-adapter-"));
  const output: string[] = [];
  const errors: string[] = [];
  const filesystemCalls: string[] = [];
  const fileSystem = injectedUpdateFileSystem(filesystemCalls, homeDirectory, adapterRoot);
  const oldTree: readonly SkillTreeFile[] = [{ path: "portable/demo/SKILL.md", content: Buffer.from("old"), executable: false }];
  const newTree: readonly SkillTreeFile[] = [{ path: "portable/demo/SKILL.md", content: Buffer.from("new"), executable: false }];
  const oldVersion = { kind: "builtin-package" as const, version: "0.1.0" };
  const newVersion = { kind: "builtin-package" as const, version: "0.2.0" };
  const records: ProjectSkillSelection[] = [{
    source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
    path: "portable/demo",
    version: { policy: "latest" },
    hosts: ["pi"],
    methods: { update: { kind: "command", argv: ["node", "scripts/update.mjs"], cwd: "tools" } },
    installation: {
      path: ".agents/skills/demo",
      adopted: false,
      resolvedVersion: oldVersion,
      baseline: skillTreeBaseline(oldTree),
    },
  }];
  let executed = false;
  try {
    for (const root of [homeDirectory, adapterRoot]) {
      await mkdir(path.join(root, ".agents", "skills", "demo"), { recursive: true });
      await mkdir(path.join(root, "tools"));
      await writeFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "old");
    }
    const operations = fakeOperations({
      async listUserGlobalInstallations() { return records; },
      async updateUserGlobalInstallation(updated) { records[0] = updated; },
      async executeInstallationMethod() { executed = true; },
    });
    const dependencies = {
      operations,
      homeDirectory,
      sourceAccess: {
        async readSkillTree() {
          return newTree;
        },
        async readSkillTreeSnapshot() {
          return { files: newTree, resolvedVersion: newVersion };
        },
      },
      installationOptions: { fileSystem },
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };

    assert.equal(await runCli(["update", "check", "--scope", "user-global"], dependencies), 0);
    assert.match(output.join("\\n"), /Updateable \(1\)/);
    output.length = 0;
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--all"], dependencies), 1);
    assert.equal(executed, false);
    assert.match(output.join("\\n"), /external command: argv=/);
    assert.match(output.join("\\n"), /external cwd:/);
    assert.match(output.join("\\n"), /declared changes:/);
    assert.match(output.join("\\n"), /cannot verify or roll back/);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
    const callsAfterPreview = filesystemCalls.length;
    assert.ok(callsAfterPreview > 0, "the injected filesystem must handle update preview");

    output.length = 0;
    errors.length = 0;
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--all", "--yes"], dependencies), 0);
    assert.ok(filesystemCalls.length > callsAfterPreview, "the injected filesystem must handle update application");
    assert.ok(filesystemCalls.some((call) => call.startsWith("writeFile:")), "the injected filesystem must write staged files");
    assert.ok(filesystemCalls.filter((call) => call.startsWith("rename:")).length >= 2, "the injected filesystem must perform atomic renames");
    assert.equal(executed, true);
    assert.match(output.join("\\n"), /Update summary: 1 updated, 0 failed/);
    assert.equal(await readFile(path.join(homeDirectory, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
    assert.equal(await readFile(path.join(adapterRoot, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "new");
    assert.deepEqual(records[0]?.installation, {
      path: ".agents/skills/demo",
      adopted: false,
      resolvedVersion: newVersion,
      baseline: skillTreeBaseline(newTree),
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
    await rm(adapterRoot, { recursive: true, force: true });
  }
});

test("tui command renders the TUI with the injected Source operations", async () => {
  const operations = fakeOperations();
  const rendered: SourceOperations[] = [];
  const code = await runCli(["tui"], {
    operations,
    renderTui: async (received) => {
      rendered.push(received);
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(rendered, [operations]);
});
