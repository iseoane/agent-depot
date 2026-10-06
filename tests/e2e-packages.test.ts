import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createPackageOperations, type PackageOperations } from "../src/package-flow.js";
import type { PackageLifecyclePlan, PackageSelection } from "../src/package-model.js";
import type { ProcessRunOptions, ProcessRunResult } from "../src/process-runner.js";
import { createSourceOperations, type SourceOperations } from "../src/sources.js";

const PORTABLE_URL = "https://example.test/packages/pstack.git";
const PI_IDENTITY = "git:example.test/packages/pstack";
const CLAUDE_INSTALL_ID = "pstack@pstack-claude";
const INSTALLED_COMMIT = "b".repeat(40);
const UPDATED_COMMIT = "c".repeat(40);
const STALE_VERSION = "0.9.60";
const AVAILABLE_VERSION = "0.9.69";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

type Runner = (command: string, args: readonly string[], options?: ProcessRunOptions) => Promise<ProcessRunResult>;

function okResult(): ProcessRunResult {
  return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", outputTooLarge: false };
}

function argvOf(plan: PackageLifecyclePlan): readonly (readonly string[])[] {
  return plan.commands.map((command) => [command.executable, ...command.args]);
}

/**
 * The real fixture repository: the pstack shape committed to Git, reached through
 * a portable HTTPS URL that Git rewrites to the local path, so the whole Source
 * path is real while no network is used.
 */
const root = await mkdtemp(path.join(tmpdir(), "agent-depot-e2e-packages-"));
after(() => rm(root, { recursive: true, force: true }));

const repository = path.join(root, "pstack");
await cp(path.resolve("tests", "fixtures", "packages", "pstack"), repository, { recursive: true });
const gitConfig = path.join(root, "gitconfig");
await writeFile(gitConfig, `[url "file://${repository}"]\n\tinsteadOf = ${PORTABLE_URL}\n[protocol "file"]\n\tallow = always\n[user]\n\tname = e2e\n\temail = e2e@example.test\n`);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "fixture"]]) {
  execFileSync("git", args, { cwd: repository, stdio: "pipe" });
}

interface FakeHost {
  readonly runner: Runner;
  readonly calls: readonly Call[];
  /** Writes the `packages[]` entry Pi would leave after an install. */
  setPiEntry(entry: string | undefined): Promise<void>;
}

/**
 * A stand-in for the two host CLIs over their own state files. Every command is
 * recorded, and the handler writes the state the real host would leave, so the
 * flow's next read comes from the fixture home rather than from the runner.
 */
async function createFakeHost(home: string): Promise<FakeHost> {
  const piSettings = path.join(home, ".pi", "agent", "settings.json");
  const claudePlugins = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const claudeMarketplaces = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  const calls: Call[] = [];
  let piEntry: string | undefined;
  let claudeVersion: string | undefined;
  let marketplaceUrl: string | undefined;
  const writePi = async (): Promise<void> => {
    await mkdir(path.dirname(piSettings), { recursive: true });
    await writeFile(piSettings, `${JSON.stringify({ packages: piEntry === undefined ? [] : [piEntry] }, null, 2)}\n`);
  };
  const writePlugins = async (): Promise<void> => {
    await mkdir(path.dirname(claudePlugins), { recursive: true });
    const plugins = claudeVersion === undefined ? {} : {
      [CLAUDE_INSTALL_ID]: [{
        scope: "user",
        installPath: path.join(home, ".claude", "plugins", "cache", "pstack"),
        version: claudeVersion,
      }],
    };
    await writeFile(claudePlugins, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
  };
  const writeMarketplaces = async (): Promise<void> => {
    await mkdir(path.dirname(claudeMarketplaces), { recursive: true });
    const records = marketplaceUrl === undefined ? {} : {
      "pstack-claude": {
        source: { source: "git", url: marketplaceUrl },
        installLocation: path.join(home, ".claude", "plugins", "marketplaces", "pstack-claude"),
        lastUpdated: "2026-01-01T00:00:00.000Z",
      },
    };
    await writeFile(claudeMarketplaces, `${JSON.stringify(records, null, 2)}\n`);
  };
  const runner: Runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (path.basename(command) === "pi") {
      // Pi records the commit it resolved, which the observed settings form shows as `@<commit>`.
      if (args[0] === "install") piEntry = `${PI_IDENTITY}@${INSTALLED_COMMIT}`;
      else if (args[0] === "update") piEntry = `${PI_IDENTITY}@${UPDATED_COMMIT}`;
      else if (args[0] === "remove") piEntry = undefined;
      await writePi();
    } else if (path.basename(command) === "claude") {
      if (args[1] === "marketplace" && args[2] === "add") {
        marketplaceUrl = args[3];
        await writeMarketplaces();
      } else if (args[1] === "install") {
        // The marketplace entry is stale, so the install lands the older version.
        claudeVersion = STALE_VERSION;
        await writePlugins();
      } else if (args[1] === "update") {
        claudeVersion = AVAILABLE_VERSION;
        await writePlugins();
      } else if (args[1] === "uninstall") {
        claudeVersion = undefined;
        await writePlugins();
      }
    }
    return okResult();
  };
  return {
    runner,
    calls,
    async setPiEntry(next) {
      piEntry = next;
      await writePi();
    },
  };
}

interface Side {
  readonly base: string;
  readonly home: string;
  readonly stateDirectory: string;
  readonly sources: SourceOperations;
  readonly source: Awaited<ReturnType<SourceOperations["addGitSource"]>>;
  readonly host: FakeHost;
  readonly operations: PackageOperations;
}

async function createSide(name: string): Promise<Side> {
  const base = path.join(root, name);
  const home = path.join(base, "home");
  await mkdir(home, { recursive: true });
  const sources = createSourceOperations({ homeDirectory: home, statePath: path.join(base, "sources.json") });
  const source = await sources.addGitSource(PORTABLE_URL);
  const host = await createFakeHost(home);
  const stateDirectory = path.join(base, "state");
  const operations = createPackageOperations({
    homeDirectory: home,
    stateDirectory,
    platform: "linux",
    isWsl: false,
    sourceOperations: sources,
    resolveExecutable: async (executable) => `/usr/bin/${executable}`,
    runner: host.runner,
  });
  return { base, home, stateDirectory, sources, source, host, operations };
}

function piSelection(url: string, version: PackageSelection["version"] = { policy: "latest" }): PackageSelection {
  return { host: "pi", root: "", source: { kind: "external", url }, version };
}

function claudeSelection(url: string, version: PackageSelection["version"] = { policy: "latest" }): PackageSelection {
  return { host: "claude", marketplaceRoot: "", pluginName: "pstack", source: { kind: "external", url }, version };
}

async function readPiPackages(home: string): Promise<readonly string[]> {
  const parsed = JSON.parse(await readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8")) as { packages?: readonly string[] };
  return parsed.packages ?? [];
}

async function fileTree(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const contents = (await readFile(full)).toString("base64");
        files.set(path.relative(directory, full), `${contents}:${(await stat(full)).mtimeMs}`);
      } else files.set(path.relative(directory, full), "link");
    }
  }
  await walk(directory);
  return files;
}

test("one pstack-shaped repository yields a Pi and a Claude descriptor over one skills directory", async () => {
  const side = await createSide("descriptors");
  await side.sources.refreshSource(side.source.id);
  const descriptors = await side.operations.discover([side.source.id]);
  assert.equal(descriptors.length, 2);
  const pi = descriptors.find((descriptor) => descriptor.host === "pi");
  const claude = descriptors.find((descriptor) => descriptor.host === "claude");
  assert.ok(pi);
  assert.ok(claude);
  assert.deepEqual(pi.coordinates, { host: "pi", root: "" });
  assert.deepEqual(claude.coordinates, { host: "claude", marketplaceRoot: "", pluginName: "pstack" });

  const piSkills = pi.components.find((component) => component.kind === "skills");
  const claudeSkills = claude.components.find((component) => component.kind === "skills");
  assert.deepEqual(piSkills?.paths, ["plugins/pstack/skills"]);
  assert.deepEqual(claudeSkills?.paths, ["plugins/pstack/skills"]);
  assert.deepEqual(piSkills?.skillNames, ["how", "poteto-mode"]);
  assert.deepEqual(claudeSkills?.skillNames, ["how", "poteto-mode"]);
});

test("the Pi lifecycle installs, updates and uninstalls through the fake host with asserted argv", async () => {
  const side = await createSide("pi-lifecycle");
  const selection = piSelection(side.source.url);

  const install = await side.operations.planLifecycle(selection, "install");
  assert.deepEqual(argvOf(install), [["pi", "install", PI_IDENTITY]]);
  assert.equal(install.skipExecution, undefined);
  assert.deepEqual(install.affects, [{ host: "pi", root: "" }]);
  assert.equal(install.cwd, side.home);
  assert.equal(install.environment, "linux");
  await side.operations.approve(selection, "install");
  const installed = await side.operations.executeLifecycle(install, true);
  assert.equal(installed.status, "installed");
  assert.deepEqual(await readPiPackages(side.home), [`${PI_IDENTITY}@${INSTALLED_COMMIT}`]);

  // The record and the evidence come from the fixture home, not from the runner.
  const inspection = await side.operations.inspect(selection);
  assert.deepEqual(inspection.installed, { kind: "installed", commit: INSTALLED_COMMIT });
  const records = await side.operations.list();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.verified, { kind: "git-commit", commit: INSTALLED_COMMIT });

  const update = await side.operations.planLifecycle(selection, "update");
  assert.deepEqual(argvOf(update), [["pi", "update", PI_IDENTITY]]);
  await side.operations.approve(selection, "update");
  const updated = await side.operations.executeLifecycle(update, true);
  assert.equal(updated.status, "updated");
  assert.deepEqual(updated.previous, { kind: "installed", commit: INSTALLED_COMMIT });
  assert.deepEqual(updated.verified, { kind: "installed", commit: UPDATED_COMMIT });
  assert.deepEqual(await readPiPackages(side.home), [`${PI_IDENTITY}@${UPDATED_COMMIT}`]);

  const uninstall = await side.operations.planLifecycle(selection, "uninstall");
  assert.deepEqual(argvOf(uninstall), [["pi", "remove", PI_IDENTITY]]);
  await side.operations.approve(selection, "uninstall");
  const removed = await side.operations.executeLifecycle(uninstall, true);
  assert.equal(removed.status, "removed");
  assert.deepEqual(await readPiPackages(side.home), []);
  assert.deepEqual(await side.operations.list(), []);

  assert.deepEqual(side.host.calls.map((call) => [path.basename(call.command), ...call.args]), [
    ["pi", "install", PI_IDENTITY],
    ["pi", "update", PI_IDENTITY],
    ["pi", "remove", PI_IDENTITY],
  ]);
});

test("the Claude lifecycle registers the marketplace, installs, updates and uninstalls", async () => {
  const side = await createSide("claude-lifecycle");
  const selection = claudeSelection(side.source.url);

  const install = await side.operations.planLifecycle(selection, "install");
  assert.deepEqual(argvOf(install), [
    ["claude", "plugin", "marketplace", "add", side.source.url],
    ["claude", "plugin", "install", CLAUDE_INSTALL_ID],
  ]);
  assert.deepEqual(install.affects, [{ host: "claude", marketplaceRoot: "", pluginName: "pstack" }]);
  await side.operations.approve(selection, "install");
  const installed = await side.operations.executeLifecycle(install, true);
  assert.equal(installed.status, "installed");

  const stale = await side.operations.checkUpdates([selection]);
  assert.equal(stale[0]?.status, "update available");
  assert.deepEqual(stale[0]?.available, { kind: "manifest-version", version: AVAILABLE_VERSION, declaredBy: "marketplace-entry" });

  const update = await side.operations.planLifecycle(selection, "update");
  assert.deepEqual(argvOf(update), [
    ["claude", "plugin", "marketplace", "update", "pstack-claude"],
    ["claude", "plugin", "update", CLAUDE_INSTALL_ID],
  ]);
  await side.operations.approve(selection, "update");
  const updated = await side.operations.executeLifecycle(update, true);
  assert.equal(updated.status, "updated");
  assert.deepEqual(updated.previous, { kind: "installed", version: STALE_VERSION });
  assert.deepEqual(updated.verified, { kind: "installed", version: AVAILABLE_VERSION });
  assert.equal((await side.operations.checkUpdates([selection]))[0]?.status, "current");

  const uninstall = await side.operations.planLifecycle(selection, "uninstall");
  assert.deepEqual(argvOf(uninstall), [["claude", "plugin", "uninstall", CLAUDE_INSTALL_ID]]);
  await side.operations.approve(selection, "uninstall");
  const removed = await side.operations.executeLifecycle(uninstall, true);
  assert.equal(removed.status, "removed");

  assert.deepEqual(side.host.calls.map((call) => [path.basename(call.command), ...call.args]), [
    ["claude", "plugin", "marketplace", "add", side.source.url],
    ["claude", "plugin", "install", CLAUDE_INSTALL_ID],
    ["claude", "plugin", "marketplace", "update", "pstack-claude"],
    ["claude", "plugin", "update", CLAUDE_INSTALL_ID],
    ["claude", "plugin", "uninstall", CLAUDE_INSTALL_ID],
  ]);
});

test("installed evidence is read from the fixture host home, and an unversioned record is unknown", async () => {
  const side = await createSide("unversioned");
  const selection = piSelection(side.source.url);
  const plan = await side.operations.planLifecycle(selection, "select");
  await side.operations.approve(selection, "select");
  assert.equal((await side.operations.executeLifecycle(plan, true)).status, "selected");

  // A bare identity is the form Pi writes for a package with no resolved pin.
  await side.host.setPiEntry(PI_IDENTITY);
  assert.deepEqual((await side.operations.inspect(selection)).installed, { kind: "installed" });
  const unknown = await side.operations.checkUpdates([selection]);
  assert.equal(unknown[0]?.status, "unknown");
  assert.match(unknown[0]?.reason ?? "", /no version evidence/u);

  await side.host.setPiEntry(`${PI_IDENTITY}@${INSTALLED_COMMIT}`);
  assert.deepEqual((await side.operations.inspect(selection)).installed, { kind: "installed", commit: INSTALLED_COMMIT });
});

test("a select run writes only packages.json and package-approvals and never a Host skill root", async () => {
  const side = await createSide("read-only");
  for (const directory of [path.join(side.home, ".pi", "agent", "skills", "keep"), path.join(side.home, ".agents", "skills", "keep")]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "---\nname: keep\ndescription: fixture\n---\n");
  }
  const before = await fileTree(side.base);

  const selection = piSelection(side.source.url);
  const plan = await side.operations.planLifecycle(selection, "select");
  await side.operations.approve(selection, "select");
  const result = await side.operations.executeLifecycle(plan, true);
  assert.equal(result.status, "selected");
  assert.deepEqual(side.host.calls, []);

  const after = await fileTree(side.base);
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...before.keys()].filter((key) => after.has(key) && after.get(key) !== before.get(key));
  assert.equal(added.length, 2);
  assert.match(added[0]!, /^state\/package-approvals\/[0-9a-f]{64}\.json$/u);
  assert.equal(added[1], "state/packages.json");
  assert.deepEqual(removed, []);
  assert.deepEqual(changed, []);
  assert.ok(![...after.keys()].some((key) => key.startsWith("home/") && !before.has(key)));
});
