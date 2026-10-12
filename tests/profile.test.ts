import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { createAppOperations } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { buildProfileExport, requireProfileExportSelection, writeProfileExport } from "../src/profile-export.js";
import { runProfileExport, runProfileImport } from "../src/profile-cli.js";
import { test } from "node:test";
import { AGENT_DEPOT_PACKAGE_VERSION } from "../src/project-manifest.js";
import { parseProfile, serializeProfile } from "../src/profile.js";
import type { PackageSelection } from "../src/package-model.js";
import { claudePackage, fakePackageOperations, installedPackage, piPackage } from "./profile-package-fixture.js";

const recipe = {
  name: "tool", platform: "windows", install: { manual: "Install tool" },
  update: { argv: ["npm", "update", "tool"] }, uninstall: { manual: "Remove tool" },
  version: { argv: ["tool", "--version"], pattern: "(.*)" },
};
const profile = {
  format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
  sources: [{ url: "https://example.com/skills.git", included: true }],
  skills: [{ source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi", "claude"],
    methods: { update: { kind: "command", argv: ["tool", "update"] } } }],
  apps: [recipe],
  packages: [],
};
const piDeclaration = { host: "pi", root: "plugins/demo",
  source: { kind: "external", url: "https://example.test/demo.git" }, version: { policy: "latest" } };
const claudeDeclaration = { host: "claude", marketplaceRoot: "plugins/demo", pluginName: "demo",
  source: { kind: "builtin", id: "builtin:agent-depot" }, version: { policy: "fixed", version: "0.3.0" } };

test("portable v1 profile round-trips Sources, selections and full cross-platform recipes", () => {
  const parsed = parseProfile(profile);
  assert.deepEqual(parseProfile(JSON.parse(serializeProfile(parsed))), parsed);
  assert.equal(JSON.parse(serializeProfile(parsed)).format, "agent-depot-profile/v1");
});

test("v2 replica intents are identity-only, reference declarations, and read legacy profiles", () => {
  const replicaProfile = parseProfile({ ...profile, format: "agent-depot-profile/v2", replicas: [
    { kind: "skill", source: profile.skills[0]!.source, path: "doctor-md-agents" },
    { kind: "app", name: "tool", platform: "windows" },
  ] });
  const serialized = serializeProfile(replicaProfile);
  assert.equal(JSON.parse(serialized).format, "agent-depot-profile/v2");
  assert.deepEqual(parseProfile(JSON.parse(serialized)), replicaProfile);
  assert.throws(() => parseProfile({ ...profile, format: "agent-depot-profile/v2" }), /replicas: required/);
  assert.throws(() => parseProfile({ ...profile, replicas: [{ kind: "app", name: "tool" }] }), /requires profile v2/);
  assert.throws(() => parseProfile({ ...profile, format: "agent-depot-profile/v2", replicas: [
    { kind: "app", name: "missing" },
  ] }), /does not reference a profile resource/);
  assert.throws(() => parseProfile({ ...profile, format: "agent-depot-profile/v2", replicas: [
    { kind: "app", name: "tool", approval: "approved" },
  ] }), /replicas\[0\]\.approval: unsupported profile field/);
});

test("Package declarations round-trip canonically and an older profile parses as an empty list", () => {
  const parsed = parseProfile({ ...profile, packages: [piDeclaration, claudeDeclaration] });
  assert.deepEqual(parsed.packages, [claudeDeclaration, piDeclaration]);
  assert.equal(serializeProfile(parseProfile({ ...profile, packages: [claudeDeclaration, piDeclaration] })),
    serializeProfile(parseProfile({ ...profile, packages: [piDeclaration, claudeDeclaration] })));
  assert.equal(serializeProfile(parsed), serializeProfile(parseProfile(JSON.parse(serializeProfile(parsed)))));
  const older = { ...profile } as Partial<typeof profile>;
  delete older.packages;
  assert.deepEqual(parseProfile(older), { ...profile, packages: [], replicas: [] });
  assert.deepEqual(Object.keys(JSON.parse(serializeProfile(parseProfile(older)))),
    ["format", "agentDepotVersion", "sources", "skills", "apps"]);
  assert.deepEqual(Object.keys(JSON.parse(serializeProfile(parsed))),
    ["format", "agentDepotVersion", "sources", "skills", "apps", "packages"]);
});

test("Package declarations refuse receipts, machine paths and non-canonical coordinates", () => {
  const value = (packageValue: unknown) => ({ ...profile, packages: [packageValue] });
  for (const [entry, reason] of [
    [{ ...piDeclaration, installId: "host-install-id" }, /packages\[0\]\.installId: unsupported profile field/],
    [{ ...piDeclaration, verifiedAt: "2026-01-01T00:00:00.000Z" }, /packages\[0\]\.verifiedAt/],
    [{ ...piDeclaration, approval: "approved" }, /packages\[0\]\.approval/],
    [{ ...piDeclaration, host: "codex" }, /packages\[0\]\.host: expected/],
    [{ ...piDeclaration, root: "/plugins/demo" }, /packages\[0\]\.root: expected a canonical/],
    [{ ...piDeclaration, root: "plugins/../demo" }, /packages\[0\]\.root: expected a canonical/],
    [{ ...piDeclaration, root: "C:/plugins/demo" }, /packages\[0\]\.root: absolute local paths are not portable/],
    [{ ...claudeDeclaration, pluginName: "demo/nested" }, /packages\[0\]\.pluginName: expected one plugin name/],
    [{ ...claudeDeclaration, pluginName: undefined }, /packages\[0\]\.pluginName: expected a plugin name/],
    [{ ...piDeclaration, source: { kind: "external", url: "/home/user/repo" } }, /packages\[0\]\.source\.url/],
    [{ ...piDeclaration, source: { kind: "external", url: "https://user:secret@example.test/demo.git" } }, /packages\[0\]\.source\.url/],
    [{ ...piDeclaration, version: { policy: "fixed", version: "C:/tool" } }, /packages\[0\]\.version\.version/],
  ] as const) assert.throws(() => parseProfile(value(entry)), reason);
  assert.throws(() => parseProfile({ ...profile, packages: [piDeclaration, piDeclaration] }), /packages\[1\]: duplicate identity/);
  assert.equal(parseProfile({ ...profile, packages: [piDeclaration, { ...piDeclaration, source: { kind: "builtin", id: "builtin:agent-depot" } }] }).packages.length, 2);
});

test("profile rejects unknown fields, versions and nonportable content with field paths", () => {
  for (const [value, reason] of [
    [{ ...profile, format: "agent-depot-profile/v3" }, /profile.format/],
    [{ ...profile, approvals: [] }, /profile.approvals/],
    [{ ...profile, sources: [{ url: "/home/user/repo", included: false }] }, /sources\[0\].url/],
    [{ ...profile, skills: [{ ...profile.skills[0], installation: { path: "local" } }] }, /skills\[0\].installation/],
    [{ ...profile, skills: [{ ...profile.skills[0], source: { kind: "external", path: "local" } }] }, /skills\[0\].source.path/],
    [{ ...profile, apps: [{ ...recipe, version: { argv: ["sh"], pattern: "(.*)" } }] }, /apps\[0\].version.argv/],
    [{ ...profile, apps: [{ ...recipe, install: { manual: "Install /home/user/tool" } }] }, /apps\[0\].install.manual/],
    [{ ...profile, skills: [{ ...profile.skills[0], methods: { install: { kind: "command", argv: ["tool", "C:\\Users\\me\\tool"] } } }] }, /skills\[0\].methods.install.argv\[1\]/],
    [{ ...profile, apps: [{ ...recipe, homepage: "https://user:secret@example.com" }] }, /apps\[0\].homepage/],
  ] as const) assert.throws(() => parseProfile(value), reason);
});

test("export includes portable managed state without running App lifecycle commands", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  // Registration is offline at this seam; no discovery or refresh is needed for export.
  const source = await operations.addGitSource("https://example.com/skills.git");
  await operations.addUserGlobalInstallation!({
    source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi", "claude"],
    installation: { path: ".agents/skills/doctor-md-agents", adopted: false },
  });
  const versionProbes: string[][] = [];
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps"),
    runner: async (_command, args) => {
      versionProbes.push([...args]);
      throw new Error("fixture executable should be unavailable");
    }, resolveExecutable: async () => undefined });
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "tool.json"), JSON.stringify(recipe));
  const result = await buildProfileExport(operations, apps, { homeDirectory: home });
  assert.deepEqual(result.profile.sources, [{ url: source.url, included: true }]);
  assert.deepEqual(result.profile.skills, [{ source: { kind: "builtin", id: "builtin:agent-depot" },
    path: "doctor-md-agents", version: { policy: "latest" }, hosts: ["pi", "claude"] }]);
  assert.deepEqual(result.profile.apps, [recipe]);
  assert.deepEqual(result.profile.replicas, [{ kind: "skill", source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents" }]);
  assert.deepEqual(versionProbes, []);
  assert.match(result.preview.join("\n"), /Not transferred because it is always present: built-in Source/);
  assert.doesNotMatch(serializeProfile(result.profile), /installation|adopted|approvals/);
});

test("export writes Package declarations without receipts or installed state", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-packages-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const { operations: packageOperations, evidence } = fakePackageOperations({ recorded: [installedPackage] });
  const result = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations });
  assert.deepEqual(result.profile.packages, [piPackage]);
  assert.deepEqual(result.profile.replicas, []);
  assert.doesNotMatch(serializeProfile(result.profile), /installId|lastDelegatedCommit|verified|receipt|approval/);
  assert.match(result.preview.join("\n"), /Package pi plugins\/demo from https:\/\/example\.test\/demo\.git \(latest; saved selection\); no receipt or installed evidence/);
  assert.deepEqual([evidence.listed, evidence.approvals.length, evidence.plans.length, evidence.executions.length], [1, 0, 0, 0]);
});

test("approved App recipes are available choices, but only a tracked installation becomes replica intent", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-app-replica-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const gentleShell = { ...recipe, name: "gentle-shell", platform: "linux" as const,
    version: { argv: ["gentle-shell", "--version"], pattern: "(.*)" } };
  let installedNow = false;
  const versionCalls: string[] = [];
  const apps = createAppOperations({ homeDirectory: home, recipesDirectory: path.join(home, "apps"),
    resolveExecutable: async name => name === "gentle-shell" ? "/fixture/gentle-shell" : undefined,
    runner: async (_command, args) => {
      versionCalls.push(args.join(" "));
      return { code: installedNow ? 0 : 1, signal: null, stdout: Buffer.from("1.2.3"), stderr: "", outputTooLarge: false };
    } });
  await mkdir(apps.directory, { recursive: true });
  await writeFile(path.join(apps.directory, "gentle-shell.json"), JSON.stringify(gentleShell));
  const entry = (await apps.load())[0]!;
  await apps.approve(entry);
  const installationDirectory = path.join(home, "app-installations");
  await mkdir(installationDirectory, { recursive: true });
  const record = { name: "gentle-shell", recipeFile: entry.canonicalFile, installedVersion: "9.9.9" };
  const filename = `${createHash("sha256").update(record.name).digest("hex")}.json`;
  await writeFile(path.join(installationDirectory, filename), JSON.stringify(record));
  const absent = await buildProfileExport(operations, apps, { homeDirectory: home });
  assert.deepEqual(absent.profile.apps.map(app => app.name), ["gentle-shell"]);
  assert.deepEqual(absent.profile.replicas, []);
  assert.match(absent.preview.join("\n"), /App recipe gentle-shell \(linux; approval not transferred\)/);
  assert.match(absent.preview.join("\n"), /current version probe reports not installed; stale tracking does not create replica intent/);

  installedNow = true;
  const installed = await buildProfileExport(operations, apps, { homeDirectory: home });
  assert.deepEqual(installed.profile.replicas, [{ kind: "app", name: "gentle-shell", platform: "linux" }]);
  assert.equal(JSON.parse(serializeProfile(installed.profile)).format, "agent-depot-profile/v2");
  assert.doesNotMatch(serializeProfile(installed.profile), /1\.2\.3|recipeFile|app-installations|approval/);
  assert.deepEqual(versionCalls, ["--version", "--version"]);
  assert.equal((await apps.trackedApps())[0]?.installedVersion, "9.9.9", "read-only export inspection must not reconcile tracking");

  apps.inspectForExport = async () => { throw new Error("inspection port unavailable"); };
  const inspectionFailure = await buildProfileExport(operations, apps, { homeDirectory: home });
  assert.deepEqual(inspectionFailure.profile.apps.map(app => app.name), ["gentle-shell"]);
  const appInspectionExclusions = inspectionFailure.exclusions.filter(item => item.label.startsWith("App "));
  assert.deepEqual(appInspectionExclusions.map(item => item.block), ["replicas"]);
  assert.match(appInspectionExclusions[0]!.reason, /installation state could not be read.*inspection port unavailable/);
});

test("a saved Package selection becomes replica intent only when host evidence says installed", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-package-replica-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const pstack: PackageSelection = { host: "pi", root: "plugins/pstack",
    source: { kind: "external", url: "https://github.com/michael-denyer/pstack-claude" },
    version: { policy: "latest" } };
  const saved = { ...installedPackage, selection: pstack };
  const { operations: packageOperations } = fakePackageOperations({ recorded: [saved],
    installed: { kind: "installed", reason: "Pi settings match; checkout evidence unavailable" } });
  const result = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations });
  assert.deepEqual(result.profile.packages, [pstack]);
  assert.deepEqual(result.profile.replicas, [{ kind: "package", selection: pstack }]);
  assert.match(result.preview.join("\n"), /Installed Package pi plugins\/pstack from https:\/\/github\.com\/michael-denyer\/pstack-claude/);
  assert.doesNotMatch(serializeProfile(result.profile), /installId|lastDelegatedCommit|verifiedAt|checkout evidence/);

  const unknownOperations = fakePackageOperations({ recorded: [saved], installed: { kind: "unknown", reason: "Pi settings.json cannot be read" } });
  const unknown = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations: unknownOperations.operations });
  assert.deepEqual(unknown.profile.replicas, []);
  assert.match(unknown.preview.join("\n"), /host installation state is unknown.*Pi settings\.json cannot be read/);
});

test("Package filters follow the Source and Skill filter conventions", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-package-filters-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const recorded = [installedPackage, { ...installedPackage, selection: claudePackage }];
  const { operations: packageOperations } = fakePackageOperations({ recorded });
  const byRoot = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations, packages: ["plugins/demo"] });
  assert.deepEqual(byRoot.profile.packages, [piPackage]);
  for (const name of ["plugins/other", "other", "claude other@plugins/other"]) {
    const byName = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations, packages: [name] });
    assert.deepEqual(byName.profile.packages, [claudePackage]);
  }
  const none = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations, noPackages: true });
  assert.deepEqual(none.profile.packages, []);
  await assert.rejects(buildProfileExport(operations, apps, { homeDirectory: home, packageOperations, packages: ["missing"] }),
    /packages: unknown selection "missing"/);
  await assert.rejects(buildProfileExport(operations, apps, { homeDirectory: home, packageOperations,
    noPackages: true, packages: ["plugins/demo"] }), /packages: filters cannot be combined with --no-packages/);
});

test("export reports a recorded Package whose coordinates are not portable instead of writing it", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-package-local-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const local = { ...installedPackage, selection: { ...piPackage, root: "/abs/bundle" } };
  const { operations: packageOperations } = fakePackageOperations({ recorded: [local] });
  const result = await buildProfileExport(operations, apps, { homeDirectory: home, packageOperations });
  assert.deepEqual(result.profile.packages, []);
  assert.deepEqual(result.exclusions.filter(item => item.block === "packages"), [{ block: "packages", label: "Package pi /abs/bundle from https://example.test/demo.git (latest; saved selection)",
    reason: "not portable (packages[0].root: expected a canonical Source-relative directory)" }]);
  assert.throws(() => requireProfileExportSelection(result.profile), /Nothing selected; nothing written/);
});

test("CLI Package filters parse on export and import and need Package operations to select", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-package-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  await operations.addUserGlobalInstallation!({
    source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: ".agents/skills/doctor-md-agents", adopted: false },
  });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const { operations: packageOperations } = fakePackageOperations({ recorded: [installedPackage] });
  const stdout: string[] = [], stderr: string[] = [];
  const dependencies = { homeDirectory: home, operations, appOperations: apps,
    stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };
  assert.equal(await runCli(["export", "--package", "demo", "--skill", "doctor-md-agents"],
    { ...dependencies, packageOperations }), 0);
  assert.deepEqual(parseProfile(JSON.parse(stdout.join("\n"))).packages, [piPackage]);
  stdout.length = 0;
  assert.equal(await runCli(["export", "--no-packages", "--skill", "doctor-md-agents"],
    { ...dependencies, packageOperations }), 0);
  assert.deepEqual(parseProfile(JSON.parse(stdout.join("\n"))).packages, []);
  await assert.rejects(runProfileExport(["--package", "plugins/demo"], operations, apps, () => {}, () => {}, home),
    /Profile export requires Package operations to select Packages/);
  stdout.length = 0;
  assert.equal(await runProfileExport(["--package", "plugins/demo"], operations, apps, line => stdout.push(line),
    line => stderr.push(line), home, packageOperations), 0);
  assert.deepEqual(parseProfile(JSON.parse(stdout.join("\n"))).packages, [piPackage]);
  await assert.rejects(runProfileExport(["--package", "plugins/demo", "--package", "plugins/demo"], operations, apps,
    () => {}, () => {}, home, packageOperations), /Duplicate --package/);
  const file = path.join(home, "package-profile.json");
  await writeFile(file, JSON.stringify({ ...profile, sources: [], skills: [], apps: [], packages: [piPackage] }));
  const { operations: importOperations } = fakePackageOperations({});
  const imported: string[] = [];
  assert.equal(await runProfileImport([file, "--yes"], operations, apps, line => imported.push(line),
    { homeDirectory: home, packageOperations: importOperations }), 0);
  assert.deepEqual(imported.filter(line => /^(?:added|skipped|failed):/u.test(line)), ["added: Package pi plugins/demo from https://example.test/demo.git (latest; saved selection)"]);
  await assert.rejects(runProfileImport([file], operations, apps, () => {}, { homeDirectory: home }),
    /Profile import requires Package operations/);
});

test("CLI export keeps stdout JSON-only, previews on stderr, and supports file output and filters", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  const source = await operations.addGitSource("https://example.com/skills.git");
  await operations.addGitSource("https://example.com/other.git");
  const appOperations = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  await mkdir(appOperations.directory);
  await writeFile(path.join(appOperations.directory, "tool.json"), JSON.stringify(recipe));
  const stdout: string[] = [], stderr: string[] = [];
  const dependencies = { homeDirectory: home, operations, appOperations, stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line) };
  assert.equal(await runCli(["export", "--source", source.id, "--no-skills", "--app", "tool"], dependencies), 0);
  const exported = parseProfile(JSON.parse(stdout.join("\n")));
  assert.deepEqual(exported.sources, [{ url: source.url, included: true }]);
  assert.deepEqual(exported.apps, [recipe]);
  assert.match(stderr.join("\n"), /Preview: export/);
  stdout.length = 0;
  await operations.addUserGlobalInstallation!({
    source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: ".agents/skills/doctor-md-agents", adopted: false },
  });
  const out = path.join(home, "profile.json");
  assert.equal(await runCli(["export", "--out", out, "--no-sources", "--no-apps"], dependencies), 0);
  assert.equal(stdout.length, 0);
  assert.deepEqual(parseProfile(JSON.parse(await readFile(out, "utf8"))).sources, []);
  assert.equal(await runCli(["export", "--out", out, "--skill", "missing"], dependencies), 1);
  assert.equal(await runCli(["export", "--no-sources", "--source", source.id], dependencies), 1);
  assert.equal(await runCli(["export", "--yes"], dependencies), 1);
  assert.equal(await runCli(["export", "--out"], dependencies), 1);
});

test("export explains local Sources, App-owned Skills and invalid recipes, even with Apps deselected", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-exclude-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  await operations.addUserGlobalInstallation!({
    source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: ".agents/skills/doctor-md-agents", adopted: true },
  });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "owner.json"), JSON.stringify({ ...recipe,
    platform: undefined, skills: ["doctor-md-*"] }));
  await writeFile(path.join(apps.directory, "broken.json"), "{}");
  const adapted = { ...operations, listSources: async () => [
    { kind: "git" as const, id: "local", url: "/home/user/repo" },
  ] };
  const result = await buildProfileExport(adapted, apps, { homeDirectory: home });
  assert.deepEqual(result.profile.sources, []);
  assert.deepEqual(result.profile.skills, []);
  assert.match(result.preview.join("\n"), /local-path.*not portable/);
  assert.match(result.preview.join("\n"), /Excluded Skill doctor-md-agents: App-owned/);
  assert.match(result.preview.join("\n"), /Excluded App recipe broken.json/);
  assert.doesNotMatch(result.preview.join("\n"), /(?:\(|: )Error: /);
  assert.deepEqual((await buildProfileExport(adapted, apps, { homeDirectory: home, noApps: true })).profile.skills, []);
});

test("export preserves explicit discovery choices and repeated selections", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-select-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  const first = await operations.addGitSource("https://example.com/first.git");
  const second = await operations.addGitSource("https://example.com/second.git");
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const result = await buildProfileExport(operations, apps, {
    homeDirectory: home, sources: [first.id, second.url], includedSourceIds: [second.id],
  });
  assert.deepEqual(result.profile.sources, [
    { url: first.url, included: false }, { url: second.url, included: true },
  ]);
});

test("manual shell instructions cannot hide credentials behind shell syntax", () => {
  assert.throws(() => parseProfile({ ...profile, apps: [{ ...recipe,
    install: { manual: "tool && tool --token=secret" } }] }), /apps\[0\].install.manual.*credentials/);
});

test("profile rejects drive-absolute Skill paths and duplicate portable identities", () => {
  assert.throws(() => parseProfile({ ...profile, skills: [{ ...profile.skills[0], path: "C:/Users/me/skill" }] }), /skills\[0\].path/);
  assert.throws(() => parseProfile({ ...profile, sources: [...profile.sources, ...profile.sources] }), /sources\[1\]/);
  assert.throws(() => parseProfile({ ...profile, apps: [recipe, recipe] }), /apps\[1\]/);
  assert.equal(parseProfile({ ...profile, apps: [recipe, { ...recipe, platform: "linux" }] }).apps.length, 2);
});

test("portable command arguments reject root-only and Windows root-relative paths", () => {
  for (const argument of ["/", "\\Users\\me"]) {
    assert.throws(() => parseProfile({ ...profile, apps: [{ ...recipe,
      install: { argv: ["tool", argument] } }] }), /apps\[0\].install.argv\[1\]/);
  }
});

test("Skill parser errors use profile field paths rather than manifest wrappers", () => {
  assert.throws(() => parseProfile({ ...profile, skills: [{ ...profile.skills[0], hosts: ["unknown"] }] }),
    { message: /^skills\[0\].hosts\[0\]: / });
});

test("portable profiles reject query credentials in method URLs", () => {
  for (const key of ["token", "key", "apikey", "api_key", "secret", "password", "passwd", "auth", "sig", "signature", "access_token", "TOKEN"]) {
    assert.throws(() => parseProfile({ ...profile, skills: [{ ...profile.skills[0],
      methods: { update: { kind: "command", argv: ["curl", `https://api.x.com/?${key}=abc`] } } }] }),
    { message: /^skills\[0\].methods.update.argv\[1\]: credentials/ });
  }
});

test("portable recipe instructions allow home-relative guidance and regex path literals", () => {
  const portableRecipe = { ...recipe, install: { manual: "add ~/bin to PATH" },
    version: { ...recipe.version, pattern: "/opt/tool/(.*)" } };
  assert.deepEqual(parseProfile({ ...profile, apps: [portableRecipe] }).apps, [portableRecipe]);
});

test("CLI export refuses an existing output path with guidance and leaves it unchanged", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-existing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const out = path.join(home, "profile.json");
  await writeFile(out, "keep this content\n");
  const stderr: string[] = [];
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  await operations.addGitSource("https://example.com/skills.git");
  assert.equal(await runCli(["export", "--out", out], {
    homeDirectory: home, operations,
    appOperations: createAppOperations({ recipesDirectory: path.join(home, "apps") }),
    stdout: () => assert.fail("file export must not write stdout"), stderr: line => stderr.push(line),
  }), 1);
  assert.equal(await readFile(out, "utf8"), "keep this content\n");
  assert.match(stderr.at(-1)!, /profile.json.*already exists; choose another path/);
});

test("Source and external Skill URLs reject credentials with the corresponding field path", () => {
  for (const url of ["https://user:secret@example.com/skills.git", "https://example.com/skills.git?token=abc"]) {
    assert.throws(() => parseProfile({ ...profile, sources: [{ url, included: true }] }),
      { message: /^sources\[0\].url: / });
    assert.throws(() => parseProfile({ ...profile, skills: [{ ...profile.skills[0],
      source: { kind: "external", url } }] }), { message: /^skills\[0\].source.url: / });
  }
});

test("CLI filters Skills and Apps by name and records the running package version", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-names-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  for (const name of ["chosen", "other"]) {
    await operations.addUserGlobalInstallation!({
      source: { kind: "builtin", id: "builtin:agent-depot" }, path: `nested/${name}`,
      version: { policy: "latest" }, hosts: ["pi"],
      installation: { path: `.agents/skills/${name}`, adopted: false },
    });
  }
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  await mkdir(apps.directory);
  for (const name of ["chosen-app", "other-app"]) {
    await writeFile(path.join(apps.directory, `${name}.json`), JSON.stringify({ ...recipe, name }));
  }
  const stdout: string[] = [];
  assert.equal(await runCli(["export", "--skill", "chosen", "--app", "chosen-app"], {
    homeDirectory: home, operations, appOperations: apps, stdout: line => stdout.push(line), stderr: () => {},
  }), 0);
  const exported = parseProfile(JSON.parse(stdout.join("\n")));
  assert.equal(exported.agentDepotVersion, AGENT_DEPOT_PACKAGE_VERSION);
  assert.deepEqual(exported.skills.map(skill => skill.path), ["nested/chosen"]);
  assert.deepEqual(exported.apps.map(app => app.name), ["chosen-app"]);
});

test("export is canonical across insertion orders and warns about omitted Skill Sources", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "z.json"), JSON.stringify({ ...recipe, name: "z-app" }));
  await writeFile(path.join(apps.directory, "a.json"), JSON.stringify({ ...recipe, name: "a-app" }));
  const outputs: string[] = [];
  for (const [index, order] of [["z", "a"], ["a", "z"]].entries()) {
    const operations = createSourceOperations({ statePath: path.join(home, `sources-${index}.json`) });
    for (const name of order) {
      const source = await operations.addGitSource(`https://example.com/${name}.git`);
      await operations.addUserGlobalInstallation!({
        source: { kind: "external", url: source.url }, path: `skills/${name}`,
        version: { policy: "latest" }, hosts: ["pi"],
        installation: { path: `.agents/skills/${name}`, adopted: false },
      });
    }
    const result = await buildProfileExport(operations, apps, { homeDirectory: home });
    outputs.push(serializeProfile(result.profile));
    assert.deepEqual(result.profile.sources.map(source => source.url), ["https://example.com/a.git", "https://example.com/z.git"]);
    assert.deepEqual(result.profile.skills.map(skill => skill.path), ["skills/a", "skills/z"]);
    assert.deepEqual(result.profile.apps.map(app => app.name), ["a-app", "z-app"]);
    const partial = await buildProfileExport(operations, apps, { homeDirectory: home, noSources: true });
    assert.match(partial.preview.join("\n"), /WARNING: Skill skills\/a references Source https:\/\/example.com\/a.git not included in profile/);
  }
  assert.equal(outputs[0], outputs[1]);
});

test("export reports named unmanaged Skills and only real exclusions", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-unmanaged-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const options = { homeDirectory: home, noSources: true };
  const empty = await buildProfileExport(operations, apps, options);
  assert.deepEqual(empty.preview, ["Preview: export portable user-global profile",
    "Selected Skills are exported with their version policy; destination install paths and Host links are recreated. Local paths and symlink targets do not travel."]);
  const skill = path.join(home, ".agents", "skills", "unmanaged-tool");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: unmanaged-tool\ndescription: A tool\n---\nInstructions\n");
  const result = await buildProfileExport(operations, apps, options);
  assert.match(result.preview.join("\n"), /Excluded unmanaged Skill unmanaged-tool: not tracked/);
  assert.doesNotMatch(result.preview.join("\n"), /Excluded App approvals|Excluded unmanaged Skills, project-scope/);
});

test("profile serialization orders same-name platform recipes independently of input order", () => {
  const linux = { ...recipe, platform: "linux" };
  const first = parseProfile({ ...profile, apps: [recipe, linux] });
  const second = parseProfile({ ...profile, apps: [linux, recipe] });
  assert.equal(serializeProfile(first), serializeProfile(second));
  assert.deepEqual(first.apps.map(app => app.platform), ["linux", "windows"]);
});

test("query credential checks cover non-HTTP URLs and encoded parameter names", () => {
  assert.throws(() => parseProfile({ ...profile, skills: [{ ...profile.skills[0],
    methods: { update: { kind: "command", argv: ["curl", "ftp://api.x.com/?%74oken=abc"] } } }] }),
  { message: /^skills\[0\].methods.update.argv\[1\]: credentials/ });
});

test("malformed URLs in recipe text report the exact field path", () => {
  assert.throws(() => parseProfile({ ...profile, apps: [{ ...recipe,
    install: { manual: "see http://[bad" } }] }),
  { message: "apps[0].install.manual: invalid URL" });
});

test("URL credential keys normalize separators and cover fragments", () => {
  for (const suffix of ["?api-key=1", "?api_key=1", "?access_token=1", "?accesstoken=1",
    "?private-token=1", "?PRIVATE_TOKEN=1", "#token=1", "#api-key=1", "#%74oken=1"]) {
    assert.throws(() => parseProfile({ ...profile, apps: [{ ...recipe,
      install: { argv: ["curl", `https://api.x.com/${suffix}`] } }] }),
    { message: "apps[0].install.argv[1]: credentials are not portable" });
  }
});

test("profile rejects same-name recipes whose applicability overlaps on any platform", () => {
  for (const apps of [[recipe, { ...recipe, platform: undefined }],
    [{ ...recipe, platform: undefined }, { ...recipe, platform: "linux" }]]) {
    assert.throws(() => parseProfile({ ...profile, apps }), /apps\[1\].*duplicate.*applicable/);
  }
  assert.deepEqual(parseProfile({ ...profile, apps: [recipe, { ...recipe, platform: "linux" }] }).apps.map(app => app.platform),
    ["linux", "windows"]);
});


test("empty exports are refused by the core writer and CLI without creating files or stdout", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-empty-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const appOperations = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const empty = parseProfile({ ...profile, sources: [], skills: [], apps: [] });
  const out = path.join(home, "empty.json");
  await assert.rejects(writeProfileExport(out, empty), /Nothing selected; nothing written/);
  await assert.rejects(access(out), { code: "ENOENT" });
  const stdout: string[] = [], stderr: string[] = [];
  const dependencies = { homeDirectory: home, operations, appOperations,
    stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };
  for (const args of [["export"], ["export", "--out", out]]) {
    assert.equal(await runCli(args, dependencies), 1);
    assert.match(stderr.at(-1)!, /Nothing selected; nothing written/);
  }
  assert.deepEqual(stdout, []);
  await assert.rejects(access(out), { code: "ENOENT" });
});

test("export exposes classified exclusions and warnings while preserving the CLI preview", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-diagnostics-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  await operations.addUserGlobalInstallation!({
    source: { kind: "external", url: "https://example.com/omitted.git" }, path: "demo",
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: ".agents/skills/demo", adopted: false },
  });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const result = await buildProfileExport(operations, apps, { homeDirectory: home });
  assert.ok("exclusions" in result);
  assert.deepEqual(result.exclusions, [
    { block: "sources", label: "built-in Source", reason: "always present (built-in Skill selections remain portable)" },
  ]);
  assert.ok("warnings" in result);
  assert.deepEqual(result.warnings, [{ kind: "source", message: "WARNING: Skill demo references Source https://example.com/omitted.git not included in profile" }]);
  assert.deepEqual(result.preview, [
    "Preview: export portable user-global profile",
    "Selected Skills are exported with their version policy; destination install paths and Host links are recreated. Local paths and symlink targets do not travel.",
    "Skill demo [pi] (latest)",
    "Replica intent Installed Skill demo from https://example.com/omitted.git; no installed state or approval is transferred",
    "Not transferred because it is always present: built-in Source",
    "WARNING: Skill demo references Source https://example.com/omitted.git not included in profile",
  ]);
});
