import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createAppOperations } from "../src/app-flow.js";
import { runCli, type CliDependencies } from "../src/cli.js";
import { AGENT_DEPOT_PACKAGE_VERSION, type ProjectSkillSelection } from "../src/project-manifest.js";
import { sourceIdForUrl } from "../src/git-source.js";
import { createProgress, NO_PROGRESS, type Progress } from "../src/progress.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import type { SelfUpdateOperations } from "../src/self-update.js";
import { BUILT_IN_SOURCE, createSourceOperations, type Source, type SourceOperations } from "../src/sources.js";
import { fakeStream, fakeTimers, recordingProgress } from "./progress-fixtures.js";

/**
 * Every long CLI step reports progress on stderr only. Each scenario runs three times in fresh
 * sandboxes: with no progress, with a recording reporter (which pins the step labels), and with the
 * real animated reporter on a fake terminal. The three must print byte-identical stdout, and the
 * animated run must leave no spinner line behind.
 */

const ERASE = "\r\u001b[2K";
const SOURCE_URL = "https://example.com/skills.git";
const demoTree: readonly SkillTreeFile[] = [{ path: "portable/demo/SKILL.md", content: Buffer.from("new"), executable: false }];
const newVersion = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };

interface Sandbox {
  readonly home: string;
  readonly operations: SourceOperations;
  readonly source: Source;
  readonly dependencies: CliDependencies;
}

type Scenario = (sandbox: Sandbox, run: (argv: string[]) => Promise<number>) => Promise<void>;

function selection(name: string, url: string): ProjectSkillSelection {
  return {
    source: { kind: "external", url },
    path: `portable/${name}`,
    version: { policy: "latest" },
    hosts: ["pi"],
    installation: { path: `.agents/skills/${name}`, adopted: false },
  };
}

async function seedSkill(home: string, name: string, content = name): Promise<void> {
  await mkdir(path.join(home, ".agents", "skills", name), { recursive: true });
  await writeFile(path.join(home, ".agents", "skills", name, "SKILL.md"), content);
}

const demoSourceAccess = {
  async readSkillTree() { return demoTree; },
  async readSkillTreeSnapshot() { return { files: demoTree, resolvedVersion: newVersion }; },
};

async function observe(scenario: Scenario, progress: Progress, overrides: (sandbox: string) => Partial<CliDependencies> = () => ({})) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-progress-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const home = path.join(root, "home");
    await mkdir(home);
    const operations = createSourceOperations({ statePath: path.join(root, "state", "sources.json") });
    const source = await operations.addGitSource(SOURCE_URL);
    const dependencies: CliDependencies = {
      operations,
      homeDirectory: home,
      projectRoot: path.join(root, "project"),
      sourceAccess: demoSourceAccess,
      appOperations: createAppOperations({ recipesDirectory: path.join(root, "apps"), homeDirectory: home }),
      stdout: (line) => stdout.push(line.replaceAll(root, "<sandbox>")),
      stderr: (line) => stderr.push(line.replaceAll(root, "<sandbox>")),
      progress,
      ...overrides(root),
    };
    await mkdir(path.join(root, "project"));
    await scenario({ home, operations, source, dependencies }, (argv) => runCli(argv, dependencies));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { stdout, stderr };
}

/** A command with no long step shows no progress at all. */
async function assertProgressNone(scenario: Scenario): Promise<void> {
  await assertProgress(scenario, [], undefined, true);
}

/** Runs the scenario with and without progress, asserts the labels and that stdout never changes. */
async function assertProgress(scenario: Scenario, expectedLabels: readonly string[], overrides?: (sandbox: string) => Partial<CliDependencies>, silent = false): Promise<void> {
  const quiet = await observe(scenario, NO_PROGRESS, overrides);
  const recorder = recordingProgress();
  const recorded = await observe(scenario, recorder, overrides);
  const stream = fakeStream({ isTTY: true, columns: 120 });
  const animated = await observe(scenario, createProgress({ stream, env: {}, timers: fakeTimers().timers }), overrides);

  assert.deepEqual(recorder.labels, expectedLabels);
  assert.deepEqual(recorded.stdout, quiet.stdout);
  assert.deepEqual(animated.stdout, quiet.stdout);
  assert.deepEqual(animated.stderr, quiet.stderr);
  if (silent) {
    assert.deepEqual(stream.writes, []);
    return;
  }
  assert.ok(stream.writes.length > 0, "the animated run drew a spinner");
  assert.equal(stream.writes.at(-1), ERASE, "the spinner line is erased at the end");
  assert.ok(stream.writes.every((text) => text.startsWith("\r")), "only spinner frames and erases reach stderr");
}

test("source add and refresh show their network steps and keep stdout identical", async () => {
  const external: Source = { id: "git:1234567890abcdef12345678", kind: "git", url: SOURCE_URL };
  const operations: SourceOperations = {
    async addGitSource() { return external; },
    async listSources() { return [BUILT_IN_SOURCE, external]; },
    async refreshSource() { return external; },
    async selectSources() { return [external]; },
  };
  await assertProgress(async (_sandbox, run) => {
    assert.equal(await run(["source", "add", SOURCE_URL]), 0);
    assert.equal(await run(["source", "refresh", external.id, "--yes"]), 0);
  }, [`Cloning ${SOURCE_URL}`, `Refreshing Git Source ${external.id}`], () => ({ operations }));
});

test("source remove shows inspection, file removal and Source removal", async () => {
  await assertProgress(async ({ home, operations }, run) => {
    await operations.addUserGlobalInstallation!(selection("kept", SOURCE_URL));
    await operations.addUserGlobalInstallation!(selection("removed", SOURCE_URL));
    await seedSkill(home, "kept");
    await seedSkill(home, "removed");
    assert.equal(await run(["source", "remove", sourceIdForUrl(SOURCE_URL), "--skill", "portable/removed", "--yes"]), 0);
  }, ["Inspecting 1 Skill for removal", "Removing Skill files", `Removing Git Source ${sourceIdForUrl(SOURCE_URL)}`]);
});

test("skill remove shows its execution step", async () => {
  await assertProgress(async ({ home, operations }, run) => {
    await operations.addUserGlobalInstallation!(selection("demo", SOURCE_URL));
    await seedSkill(home, "demo");
    assert.equal(await run(["skill", "remove", "portable/demo", "--yes"]), 0);
  }, ["Removing 1 user-global Skill"]);
});

test("uninstall shows recheck, managed, unmanaged and catalog steps", async () => {
  await assertProgress(async ({ home, operations }, run) => {
    await operations.addUserGlobalInstallation!(selection("demo", SOURCE_URL));
    await seedSkill(home, "demo");
    await seedSkill(home, "stray", "---\nname: stray\ndescription: Stray\n---\n\nStray\n");
    const stray = path.join(home, ".agents", "skills", "stray");
    assert.equal(await run(["uninstall", "--skills", "--unmanaged-skill", stray, "--data", "--yes"]), 0);
  }, ["Rechecking Skills before removal", "Removing 1 managed Skill", "Removing 1 unmanaged Skill", "Removing catalog data"]);
});

test("uninstall shows nothing for a plain CLI handoff", async () => {
  await assertProgressNone(async (_sandbox, run) => {
    assert.equal(await run(["uninstall", "--cli"]), 0);
  });
});

test("self update shows the registry check and the install", async () => {
  const selfUpdateOperations: SelfUpdateOperations = {
    async check() { return { kind: "available", current: "0.5.1", latest: "0.6.0" }; },
    async apply() { return undefined; },
  };
  await assertProgress(async (_sandbox, run) => {
    assert.equal(await run(["self", "update", "--yes"]), 0);
  }, ["Checking for Agent Depot updates", "Updating Agent Depot to 0.6.0"], () => ({ selfUpdateOperations }));
});

for (const scope of ["user-global", "project"] as const) {
  test(`install --scope ${scope} shows resolving and installing`, async () => {
    await assertProgress(async (_sandbox, run) => {
      assert.equal(await run([
        "install", "--scope", scope, "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
        "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
      ]), 0);
    }, ["Resolving portable/demo", "Installing portable/demo"]);
  });
}

test("manifest install shows resolving and per-Skill installing", async () => {
  await assertProgress(async ({ dependencies }, run) => {
    await writeFile(path.join(dependencies.projectRoot!, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{ source: { kind: "builtin", id: BUILT_IN_SOURCE.id }, path: "portable/demo", version: { policy: "latest" }, hosts: ["pi"] }],
    }));
    assert.equal(await run(["install", "--scope", "project", "--manifest", "--portable-v1", "--yes"]), 0);
  }, ["Resolving 1 manifest Skill", "Installing portable/demo"]);
});

test("update check shows the App, Package and Skill checks", async () => {
  await assertProgress(async (_sandbox, run) => {
    assert.equal(await run(["update", "check", "--scope", "user-global"]), 0);
  }, ["Checking App updates", "Checking Package updates", "Checking user-global Skill updates"]);
});

test("update apply shows the checks, the preview and the application", async () => {
  const oldTree: readonly SkillTreeFile[] = [{ path: "portable/demo/SKILL.md", content: Buffer.from("old"), executable: false }];
  await assertProgress(async ({ home, operations }, run) => {
    await seedSkill(home, "demo", "old");
    await operations.addUserGlobalInstallation!({
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: {
        path: ".agents/skills/demo",
        adopted: false,
        resolvedVersion: { kind: "builtin-package", version: "0.1.0" },
        baseline: skillTreeBaseline(oldTree),
      },
    });
    assert.equal(await run(["update", "apply", "--scope", "user-global", "--all", "--yes"]), 0);
  }, [
    "Checking App updates", "Checking Package updates", "Checking user-global Skill updates",
    "Previewing Skill updates", "Updating 1 Skill",
  ]);
});

test("export keeps stdout parseable JSON while it builds", async () => {
  const stdoutOf = async (progress: Progress) => {
    let json = "";
    await observe(async (_sandbox, run) => {
      assert.equal(await run(["export", "--no-skills", "--no-apps", "--no-packages"]), 0);
    }, progress, () => ({ stdout: (line: string) => { json += `${line}\n`; } }));
    return json;
  };
  const recorder = recordingProgress();
  const quiet = await stdoutOf(NO_PROGRESS);
  const withProgress = await stdoutOf(recorder);

  assert.equal(JSON.parse(withProgress).sources[0].url, SOURCE_URL);
  assert.equal(withProgress, quiet);
  assert.deepEqual(recorder.labels, ["Building Profile export"]);
});

test("import shows the preview build and the apply step", async () => {
  await assertProgress(async ({ home }, run) => {
    const file = path.join(home, "profile.json");
    assert.equal(await run(["export", "--out", file, "--no-skills", "--no-apps", "--no-packages"]), 0);
    const profile = JSON.parse(await readFile(file, "utf8")) as { sources: Array<{ url: string }> };
    profile.sources[0]!.url = "https://example.com/other.git";
    await writeFile(file, JSON.stringify(profile));
    assert.equal(await run(["import", file, "--yes"]), 0);
  }, ["Building Profile export", "Building import preview", "Applying import"]);
});

test("an unconfirmed command waits on no spinner: nothing runs after the preview, and the line is erased before the error", async () => {
  const stream = fakeStream({ isTTY: true });
  const animated = createProgress({ stream, env: {}, timers: fakeTimers().timers });
  const order: string[] = [];
  await observe(async ({ home, operations }, run) => {
    await operations.addUserGlobalInstallation!(selection("demo", SOURCE_URL));
    await seedSkill(home, "demo");
    // Confirmation is a --yes flag, never an interactive prompt: these stop before any step runs.
    assert.equal(await run(["skill", "remove", "portable/demo"]), 1);
    assert.equal(await run(["uninstall", "--skills"]), 1);
    assert.equal(await run(["source", "refresh", sourceIdForUrl(SOURCE_URL)]), 1);
    assert.deepEqual(stream.writes, []);
    // Resolution runs before the preview; once the preview prints, the spinner is already gone.
    assert.equal(await run(["install", "--scope", "user-global", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo",
      "--host", "pi", "--version", "latest", "--portable-v1"]), 1);
    order.push(stream.writes.at(-1) ?? "");
  }, animated);

  assert.deepEqual(order, [ERASE]);
});
