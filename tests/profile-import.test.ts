import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { test } from "node:test";
import { createAppOperations } from "../src/app-flow.js";
import type { GitSource } from "../src/git-source.js";
import { createPackageOperations, type PackageOperations } from "../src/package-flow.js";
import type { InstalledPackage, PackageSelection } from "../src/package-model.js";
import { buildProfileExport } from "../src/profile-export.js";
import { createSourceOperations, type SourceOperations } from "../src/sources.js";
import { parseProfile, serializeProfile } from "../src/profile.js";
import type { SourceContentAccess } from "../src/skill-discovery.js";
import { buildProfileImport, applyProfileImport } from "../src/profile-import.js";
import { claudePackage, fakePackageOperations, installedPackage, piPackage } from "./profile-package-fixture.js";

const recipe = { name: "tool", platform: "windows", install: { manual: "Install tool" },
  update: { manual: "Update tool" }, uninstall: { manual: "Remove tool" },
  version: { argv: ["tool", "--version"], pattern: "(.*)" } };
const selection = { source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
  version: { policy: "latest" }, hosts: ["pi"] };
const profile = parseProfile({ format: "agent-depot-profile/v1", agentDepotVersion: "99.0.0",
  sources: [{ url: "https://example.com/skills.git", included: false }], skills: [selection], apps: [recipe] });

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const home = await mkdtemp(path.join(tmpdir(), "ad-import-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps"), runner: async () => {
    throw new Error("recipe commands must not run");
  } });
  return { home, operations, apps };
}

test("import classifies Package additions, identical records and version conflicts by selection identity", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [],
    packages: [piPackage, claudePackage, { ...piPackage, root: "plugins/other-bundle" }] });
  const recorded: readonly InstalledPackage[] = [
    { ...installedPackage, selection: { ...piPackage, version: { policy: "fixed", version: "0.4.0" } } },
    { ...installedPackage, selection: claudePackage },
  ];
  const { operations: packageOperations, evidence } = fakePackageOperations({ recorded });
  const plan = await buildProfileImport(input, operations, apps, {}, packageOperations);
  assert.deepEqual(Object.fromEntries(plan.packages.map(item => [item.label, item.status])), {
    "Package claude other@plugins/other (fixed:0.3.0)": "same",
    "Package pi plugins/demo (latest)": "conflict",
    "Package pi plugins/other-bundle (latest)": "add",
  });
  const difference = plan.packages.find(item => item.status === "conflict")!.difference!;
  assert.match(difference, /version: existing .*0\.4\.0.* -> incoming .*latest/);
  assert.doesNotMatch(difference, /installId|verified|source:|root:/);
  const preview = plan.preview.join("\n");
  assert.match(preview, /add: Package pi plugins\/other-bundle \(latest\)/);
  assert.match(preview, /host pi: select records the choice; it runs no host command and installs nothing/);
  assert.match(preview, /Source https:\/\/example\.test\/demo\.git will be fetched but not registered/);
  const unconfirmed = await applyProfileImport(plan, operations, apps, false, () => {}, { homeDirectory: home, packageOperations });
  assert.deepEqual(unconfirmed.map(result => result.status), ["skipped", "skipped", "skipped"]);
  assert.deepEqual([evidence.approvals, evidence.plans, evidence.executions], [[], [], []]);
  assert.equal(evidence.listed, 1);
});

test("confirmed import selects an added Package and never approves install or update", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [], packages: [piPackage] });
  const { operations: packageOperations, evidence } = fakePackageOperations({});
  const plan = await buildProfileImport(input, operations, apps, {}, packageOperations);
  const output: string[] = [];
  const results = await applyProfileImport(plan, operations, apps, true, line => output.push(line), { homeDirectory: home, packageOperations });
  assert.deepEqual(results.map(result => [result.item.block, result.status]), [["packages", "added"]]);
  assert.deepEqual(evidence.approvals, ["select"]);
  assert.deepEqual(evidence.plans, ["select"]);
  assert.deepEqual(evidence.executions, [{ action: "select", confirmed: true }]);
  assert.match(output.join("\n"), /no host command ran/);
});

test("import refuses a select plan that carries host steps instead of running them", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [], packages: [piPackage] });
  const { operations: packageOperations, evidence } = fakePackageOperations({ commands: [
    { purpose: "apply", executable: "pi", args: ["install", "demo"], summary: "pi install demo" },
  ] });
  const plan = await buildProfileImport(input, operations, apps, {}, packageOperations);
  const results = await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home, packageOperations });
  assert.deepEqual(results.map(result => result.status), ["failed"]);
  assert.match(results[0]!.detail!, /plan carries 1 host steps; import runs no host command/);
  assert.deepEqual([evidence.approvals, evidence.executions], [[], []]);
});

test("import reports a Package select the flow did not complete and fails items without Package operations", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [], packages: [piPackage] });
  await assert.rejects(buildProfileImport(input, operations, apps), /requires Package operations/);
  await assert.rejects(buildProfileImport(input, operations, apps, { packages: ["missing"] }),
    /packages: unknown selection "missing"/);
  assert.deepEqual((await buildProfileImport(input, operations, apps, { noPackages: true })).packages, []);
  const unstarted = fakePackageOperations({ result: { status: "manual required", reason: "no host CLI" } });
  const plan = await buildProfileImport(input, operations, apps, {}, unstarted.operations);
  const results = await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home, packageOperations: unstarted.operations });
  assert.deepEqual(results.map(result => result.status), ["failed"]);
  assert.match(results[0]!.detail!, /was not selected \(manual required: no host CLI\)/);
  assert.deepEqual(unstarted.evidence.approvals, ["select"]);
  const unprovided = await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home });
  assert.deepEqual(unprovided.map(result => result.status), ["failed"]);
  assert.match(unprovided[0]!.detail!, /Profile import requires Package operations/);
});

const PI_URL = "https://example.test/demo-bundle";
const PI_COMMIT = "a".repeat(40);
const hostedSource: GitSource = Object.freeze({ id: "git:example.test/demo-bundle", kind: "git", url: PI_URL });
const hostedSelection: PackageSelection = Object.freeze({ host: "pi", root: "",
  source: Object.freeze({ kind: "external", url: PI_URL }), version: Object.freeze({ policy: "latest" }) });

/** One machine: its own state directory, host state and process runner, over one shared Source. */
async function packageSide(root: string, home: string) {
  const calls: string[][] = [];
  const contentAccess: SourceContentAccess = {
    readSnapshot: async () => Object.freeze([
      Object.freeze({ path: "package.json", content: JSON.stringify({ name: "demo-bundle", version: "1.0.0", pi: { skills: "skills" } }) }),
      Object.freeze({ path: "skills/demo/SKILL.md", content: "---\nname: demo\ndescription: demo fixture\n---\n" }),
    ]),
    readResolvedVersion: async () => Object.freeze({ kind: "git-commit" as const, commit: PI_COMMIT }),
  };
  const sourceOperations: SourceOperations = {
    addGitSource: async () => hostedSource,
    listSources: async () => Object.freeze([hostedSource]),
    refreshSource: async () => hostedSource,
    selectSources: async () => Object.freeze([hostedSource]),
    resolveProjectSource: async () => hostedSource,
    refreshProjectSource: async () => hostedSource,
    listUserGlobalInstallations: async () => Object.freeze([]),
  };
  const operations: PackageOperations = createPackageOperations({
    homeDirectory: home,
    stateDirectory: path.join(root, "state"),
    platform: "linux",
    isWsl: false,
    sourceOperations,
    sourceContentAccess: contentAccess,
    resolveExecutable: async name => `/usr/bin/${name}`,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", outputTooLarge: false };
    },
    readHostStateFile: async filePath => {
      const error = new Error(`ENOENT: no such file or directory, open ${JSON.stringify(filePath)}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  return { operations, sourceOperations, calls, state: path.join(root, "state") };
}

test("a Profile round trip restores a Package selection and never installs a bundle", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ad-profile-package-roundtrip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await packageSide(path.join(root, "a"), path.join(root, "a-home"));
  const b = await packageSide(path.join(root, "b"), path.join(root, "b-home"));
  const appsA = createAppOperations({ recipesDirectory: path.join(root, "a-apps") });
  const appsB = createAppOperations({ recipesDirectory: path.join(root, "b-apps") });

  const plan = await a.operations.planLifecycle(hostedSelection, "select");
  await a.operations.approve(hostedSelection, "select");
  assert.equal((await a.operations.executeLifecycle(plan, true)).status, "selected");
  assert.deepEqual(a.calls, []);

  const exported = await buildProfileExport(a.sourceOperations, appsA, { homeDirectory: path.join(root, "a-home"),
    packageOperations: a.operations });
  assert.deepEqual(exported.profile.packages, [hostedSelection]);
  const serialized = serializeProfile(exported.profile);
  assert.doesNotMatch(serialized, /installId|verifiedAt|lastDelegatedCommit|manifestDigest|receipt|approvals/);

  const bHome = path.join(root, "b-home");
  const imported = await buildProfileImport(JSON.parse(serialized), b.sourceOperations, appsB, {}, b.operations);
  assert.deepEqual(imported.packages.map(item => item.status), ["add"]);
  assert.deepEqual(imported.items.map(item => [item.block, item.status]), [["sources", "same"]]);
  const output: string[] = [];
  const results = await applyProfileImport(imported, b.sourceOperations, appsB, true, line => output.push(line),
    { homeDirectory: bHome, packageOperations: b.operations });
  assert.deepEqual(results.map(result => [result.item.block, result.status]), [["sources", "skipped"], ["packages", "added"]]);
  assert.deepEqual((await b.operations.list()).map(record => record.selection), [hostedSelection]);
  assert.deepEqual(b.calls, []);
  assert.match(output.join("\n"), /no host command ran/);
  assert.equal(await b.operations.approvalStatus(hostedSelection, "select"), "approved");
  assert.equal(await b.operations.approvalStatus(hostedSelection, "install"), "needs approval");

  const stateBefore = (await readdir(b.state)).sort();
  const bytesBefore = await readFile(path.join(b.state, "packages.json"), "utf8");
  const repeated = await applyProfileImport(
    await buildProfileImport(JSON.parse(serialized), b.sourceOperations, appsB, {}, b.operations),
    b.sourceOperations, appsB, true, () => {}, { homeDirectory: bHome, packageOperations: b.operations });
  assert.deepEqual(repeated.map(result => [result.status, result.detail]), [["skipped", undefined], ["skipped", undefined]]);
  assert.deepEqual((await readdir(b.state)).sort(), stateBefore);
  assert.equal(await readFile(path.join(b.state, "packages.json"), "utf8"), bytesBefore);
});

test("import plan classifies identical choices and shows conflicts without writing", async t => {
  const { home, operations, apps } = await fixture(t);
  await operations.addGitSource("https://example.com/skills.git");
  await operations.addUserGlobalInstallation!({ ...parseProfile({ ...profile, skills: [{ ...selection, hosts: ["claude"] }] }).skills[0]!, installation: { path: ".agents/skills/doctor-md-agents", adopted: false } });
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "existing.json"), JSON.stringify(recipe));
  const plan = await buildProfileImport(profile, operations, apps);
  assert.deepEqual(plan.items.map(item => item.status), ["same", "conflict", "same"]);
  assert.match(plan.preview.join("\n"), /hosts.*claude.*pi/);
  assert.match(plan.preview.join("\n"), /WARNING.*newer/);
  assert.equal((await operations.listUserGlobalInstallations!())[0]!.hosts[0], "claude");
  assert.equal(await readFile(path.join(home, "apps", "existing.json"), "utf8"), JSON.stringify(recipe));
});

test("confirmed import installs recorded Hosts and methods, writes unapproved recipes and continues after failures", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, skills: [selection, { ...selection, path: "missing-skill" }],
    apps: [recipe, { ...recipe, platform: "linux" }] });
  const plan = await buildProfileImport(input, operations, apps);
  assert.deepEqual((await applyProfileImport(plan, operations, apps, false, () => {}, { homeDirectory: home }))
    .map(result => result.status), ["skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal((await operations.listSources()).length, 1);
  assert.deepEqual(await apps.load(), []);
  const output: string[] = [];
  const results = await applyProfileImport(plan, operations, apps, true, line => output.push(line), { homeDirectory: home });
  assert.deepEqual(results.map(result => result.status), ["added", "added", "failed", "added", "added"]);
  const installed = await operations.listUserGlobalInstallations!();
  assert.deepEqual(installed.map(skill => skill.hosts), [["pi"]]);
  assert.deepEqual(installed[0]!.version, { policy: "latest" });
  assert.match(output.join("\n"), /Preview: reconcile Skill/);
  const entries = await apps.load();
  assert.equal(entries.length, 2);
  for (const entry of entries) assert.notEqual((await apps.approvalStatus(entry)).status, "approved");
  assert.deepEqual((await buildProfileImport(input, operations, apps)).items.map(item => item.status),
    ["same", "same", "add", "same", "same"]);
});

test("CLI import requires confirmation, supports export filters, and rejects malformed profiles before writes", async t => {
  const { home, operations, apps } = await fixture(t);
  const file = path.join(home, "profile.json");
  await writeFile(file, JSON.stringify(profile));
  const output: string[] = [], errors: string[] = [];
  const dependencies = { homeDirectory: home, operations, appOperations: apps,
    stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };
  assert.equal(await runCli(["import", file, "--no-skills"], dependencies), 0);
  assert.match(output.join("\n"), /not confirmed/);
  assert.equal((await operations.listSources()).length, 1);
  assert.equal(await runCli(["import", file, "--yes", "--no-skills", "--no-sources", "--app", "tool"], dependencies), 0);
  assert.equal((await apps.load()).length, 1);
  for (const args of [["--out", "x"], ["--source"], ["--yes", "--yes"], ["--skill", "missing"],
    ["--no-apps", "--app", "tool"], ["--app", "tool", "--app", "tool"]]) {
    assert.equal(await runCli(["import", file, ...args], dependencies), 1);
  }
  await writeFile(file, JSON.stringify({ ...profile, approvals: [] }));
  assert.equal(await runCli(["import", file, "--yes"], dependencies), 1);
  assert.match(errors.join("\n"), /profile.approvals/);
  assert.equal((await operations.listSources()).length, 1);
});

test("import uses the configured immutable Source tree, preserves both methods, and previews before execution", async t => {
  const { home, apps } = await fixture(t);
  const root = path.join(home, "builtin");
  await mkdir(path.join(root, "fixture-skill"), { recursive: true });
  await writeFile(path.join(root, "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Test Skill\n---\nInstructions\n");
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json"), builtInRoot: root });
  const methods = { install: { kind: "command", argv: ["node", "-e", "require('node:fs').writeFileSync('method-ran', 'yes')"] },
    update: { kind: "command", argv: ["node", "--version"] } };
  const input = parseProfile({ ...profile, sources: [], apps: [], skills: [{ ...selection, path: "fixture-skill", methods }] });
  const output: string[] = [];
  const plan = await buildProfileImport(input, operations, apps);
  assert.deepEqual((await applyProfileImport(plan, operations, apps, true, line => output.push(line), { homeDirectory: home }))
    .map(result => result.status), ["added"]);
  assert.match(output.join("\n"), /run external method: argv=.*node/);
  assert.equal(await readFile(path.join(home, "method-ran"), "utf8"), "yes");
  assert.deepEqual((await operations.listUserGlobalInstallations!())[0]!.methods, methods);
});

test("import rechecks additions and never overwrites conflicting destination recipes or Skill content", async t => {
  const { home, operations, apps } = await fixture(t);
  const plan = await buildProfileImport(profile, operations, apps);
  await operations.addGitSource(profile.sources[0]!.url);
  await mkdir(apps.directory);
  const existing = path.join(apps.directory, "my-recipe.json");
  const content = JSON.stringify({ ...recipe, install: { manual: "Keep my install" } });
  await writeFile(existing, content);
  const skill = path.join(home, ".agents", "skills", "doctor-md-agents");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: doctor-md-agents\ndescription: Local\n---\nKEEP\n");
  const result = await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home });
  assert.deepEqual(result.map(item => item.status), ["skipped", "failed", "skipped"]);
  assert.equal(await readFile(existing, "utf8"), content);
  assert.match(await readFile(path.join(skill, "SKILL.md"), "utf8"), /KEEP/);
  assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
  const replan = await buildProfileImport(profile, operations, apps);
  assert.equal(replan.items[2]!.status, "conflict");
  assert.match(replan.items[2]!.difference!, /Keep my install.*Install tool/);
});

test("built CLI fetches an unregistered pinned Git Source without registering it or using the network", async t => {
  const { home } = await fixture(t);
  const repo = path.join(home, "repo");
  const sourceUrl = "https://example.test/fixture.git";
  await mkdir(path.join(repo, "skills", "pinned"), { recursive: true });
  await writeFile(path.join(repo, "skills", "pinned", "SKILL.md"), "---\nname: pinned\ndescription: Fixture\n---\nPINNED\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"), GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.test" };
  await writeFile(env.GIT_CONFIG_GLOBAL, `[url "file://${repo}"]\n\tinsteadOf = ${sourceUrl}\n[protocol "file"]\n\tallow = always\n`);
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "pinned");
  const commit = git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "skills", "pinned", "SKILL.md"), "---\nname: pinned\ndescription: Fixture\n---\nLATEST\n");
  git("commit", "-qam", "latest");
  const input = parseProfile({ ...profile, apps: [], sources: [{ url: sourceUrl, included: true }], skills: [{
    ...selection, source: { kind: "external", url: sourceUrl, ref: commit }, path: "skills/pinned",
    version: { policy: "fixed", version: commit }, hosts: ["pi", "claude"] }] });
  const file = path.join(home, "portable.json");
  await writeFile(file, JSON.stringify(input));
  const result = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "import", file, "--no-sources", "--yes"],
    { cwd: home, env, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Source https:\/\/example\.test\/fixture\.git will be fetched but not registered/);
  assert.match(result.stdout, /scope: user-global; hosts: pi,claude; version policy: fixed:/);
  assert.match(await readFile(path.join(home, ".agents", "skills", "pinned", "SKILL.md"), "utf8"), /PINNED/);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "agent-depot", "sources.json") });
  assert.equal((await operations.listSources()).length, 1);
  const installed = await operations.listUserGlobalInstallations!();
  assert.deepEqual(installed[0]!.hosts, ["pi", "claude"]);
  assert.deepEqual(installed[0]!.version, { policy: "fixed", version: commit });
});

test("reimported recipes cannot inherit approval from a previously deleted import", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [{ ...recipe, platform: process.platform === "win32" ? "windows" : process.platform }] });
  const first = await buildProfileImport(input, operations, apps);
  await applyProfileImport(first, operations, apps, true, () => {}, { homeDirectory: home });
  const [old] = await apps.load();
  await apps.approve(old!);
  assert.equal((await apps.approvalStatus(old!)).status, "approved");
  await rm(old!.file);
  await applyProfileImport(await buildProfileImport(input, operations, apps), operations, apps, true, () => {}, { homeDirectory: home });
  const [current] = await apps.load();
  assert.equal((await apps.approvalStatus(current!)).status, "needs approval");
});

test("platform-less incoming recipes conflict with same-name platform-specific destinations without breaking existing Apps", async t => {
  const { home, operations, apps } = await fixture(t);
  await mkdir(apps.directory);
  const file = path.join(apps.directory, "foo-linux.json");
  const content = JSON.stringify({ ...recipe, name: "foo", platform: "linux" });
  await writeFile(file, content);
  const incoming = parseProfile({ ...profile, sources: [], skills: [], apps: [{ ...recipe, name: "foo", platform: undefined }] });
  const plan = await buildProfileImport(incoming, operations, apps);
  assert.equal(plan.items[0]!.status, "conflict");
  assert.match(plan.items[0]!.difference!, /foo-linux\.json.*platform.*linux.*(?:undefined|null|all platforms)/);
  assert.deepEqual((await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home })).map(result => result.status), ["skipped"]);
  assert.equal(await readFile(file, "utf8"), content);
  const entries = await apps.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.error, undefined);
});

test("invalid destination recipes reserve known names while unknown names warn without blocking", async t => {
  const { home, operations, apps } = await fixture(t);
  await mkdir(apps.directory);
  const named = path.join(apps.directory, "invalid-foo.json"), unknown = path.join(apps.directory, "unknown.json");
  await writeFile(named, JSON.stringify({ name: "foo", install: { manual: "Incomplete" } }));
  await writeFile(unknown, "{ broken JSON");
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [{ ...recipe, name: "foo" }, { ...recipe, name: "bar" }] });
  const plan = await buildProfileImport(input, operations, apps);
  assert.deepEqual(plan.items.map(item => [item.block === "apps" ? item.value.name : "", item.status]),
    [["bar", "add"], ["foo", "conflict"]]);
  assert.match(plan.preview.join("\n"), /invalid-foo\.json/);
  assert.match(plan.preview.join("\n"), /WARNING:.*unknown\.json.*name unknown/);
  const result = await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home });
  assert.deepEqual(result.map(item => item.status), ["added", "skipped"]);
  assert.equal(await readFile(unknown, "utf8"), "{ broken JSON");
});

test("unconfirmed CLI preview discloses Skill identity and every user method without fetching or writing", async t => {
  const { home, operations, apps } = await fixture(t);
  const methods = { install: { kind: "command", argv: ["tool", "install", "argument with spaces"] },
    update: { kind: "command", argv: ["tool", "update", "--flag"] } };
  const source = { kind: "external", url: "https://example.test/unregistered.git", ref: "a".repeat(40) };
  const input = parseProfile({ ...profile, sources: [], apps: [], skills: [{ ...selection, source,
    hosts: ["pi", "claude"], version: { policy: "fixed", version: "a".repeat(40) }, methods }] });
  const file = path.join(home, "preview.json");
  await writeFile(file, JSON.stringify(input));
  const output: string[] = [];
  assert.equal(await runCli(["import", file], { homeDirectory: home, operations, appOperations: apps,
    stdout: line => output.push(line), stderr: line => assert.fail(line) }), 0);
  const preview = output.join("\n");
  assert.match(preview, /Source.*a{40}.*unregistered\.git/);
  assert.match(preview, /hosts: pi,claude; version policy: fixed:a{40}/);
  for (const method of Object.values(methods)) assert.ok(preview.includes(JSON.stringify(method.argv)));
  assert.match(preview, /user-provided method from the profile, runs only after --yes/);
  assert.match(preview, /Source https:\/\/example\.test\/unregistered\.git will be fetched but not registered/);
  assert.equal((await operations.listSources()).length, 1);
  assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
  await assert.rejects(readFile(path.join(home, "sources.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(home, ".agents", "skills", "doctor-md-agents", "SKILL.md")), { code: "ENOENT" });
  assert.deepEqual(await apps.load(), []);
});

test("conflicts show only differing keys and existing Sources explain ignored discovery inclusion", async t => {
  const { operations, apps } = await fixture(t);
  await operations.addGitSource(profile.sources[0]!.url);
  await operations.addUserGlobalInstallation!({ ...parseProfile({ ...profile, skills: [{ ...selection,
    hosts: ["claude"], methods: { update: { kind: "command", argv: ["tool", "old"] } } }] }).skills[0]!,
    installation: { path: ".agents/skills/doctor-md-agents", adopted: false } });
  const input = parseProfile({ ...profile, apps: [], skills: [{ ...selection,
    version: { policy: "fixed", version: "0.3.0" }, methods: { update: { kind: "command", argv: ["tool", "new"] } } }] });
  const plan = await buildProfileImport(input, operations, apps);
  assert.match(plan.preview.join("\n"), /same \(discovery inclusion is not imported\): Source/);
  assert.match(plan.items[0]!.difference!, /included: existing true -> incoming false/);
  const difference = plan.items[1]!.difference!;
  assert.match(difference, /hosts: existing \["claude"\] -> incoming \["pi"\]/);
  assert.match(difference, /version: existing .*latest.* -> incoming .*fixed/);
  assert.match(difference, /methods: existing .*old.* -> incoming .*new/);
  assert.doesNotMatch(difference, /source:|path:|installation:/);
});

test("CLI invalid JSON diagnostics identify the profile file and leave destination untouched", async t => {
  const { home, operations, apps } = await fixture(t);
  const file = path.join(home, "broken-profile.json");
  await writeFile(file, "{not JSON");
  const errors: string[] = [];
  assert.equal(await runCli(["import", file, "--yes"], { homeDirectory: home, operations, appOperations: apps,
    stdout: () => assert.fail("invalid JSON cannot produce a plan"), stderr: line => errors.push(line) }), 1);
  assert.ok(errors[0]!.includes(`${file}: invalid JSON (`));
  assert.equal((await operations.listSources()).length, 1);
  assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
  assert.deepEqual(await apps.load(), []);
});

test("later blocks recheck destination recipes created by a confirmed Skill method", async t => {
  const { home, apps } = await fixture(t);
  const root = path.join(home, "builtin");
  await mkdir(path.join(root, "writer"), { recursive: true });
  await writeFile(path.join(root, "writer", "SKILL.md"), "---\nname: writer\ndescription: Fixture writer\n---\nInstructions\n");
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json"), builtInRoot: root });
  const created = { ...recipe, install: { manual: "Created during Skill method" } };
  const method = { kind: "command", argv: ["node", "-e", `require('node:fs').mkdirSync('apps',{recursive:true}),require('node:fs').writeFileSync('apps/late.json',${JSON.stringify(JSON.stringify(created))})`] };
  const input = parseProfile({ ...profile, sources: [], skills: [{ ...selection, path: "writer", methods: { install: method } }] });
  const plan = await buildProfileImport(input, operations, apps);
  assert.deepEqual(plan.items.map(item => item.status), ["add", "add"]);
  const result = await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home });
  assert.deepEqual(result.map(item => item.status), ["added", "skipped"]);
  assert.match(result[1]!.detail!, /late\.json.*Created during Skill method/);
  assert.equal((await apps.load()).length, 1);
  assert.equal(await readFile(path.join(apps.directory, "late.json"), "utf8"), JSON.stringify(created));
});

test("same-name destination recipes allow disjoint platforms and remain usable on Linux", async t => {
  const { home, operations, apps } = await fixture(t);
  await mkdir(apps.directory);
  const existing = path.join(apps.directory, "foo-linux.json");
  const content = JSON.stringify({ ...recipe, name: "foo", platform: "linux" });
  await writeFile(existing, content);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [{ ...recipe, name: "foo", platform: "windows" }] });
  const plan = await buildProfileImport(input, operations, apps);
  assert.equal(plan.items[0]!.status, "add");
  assert.deepEqual((await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home })).map(result => result.status), ["added"]);
  const linuxApps = createAppOperations({ recipesDirectory: apps.directory, platform: "linux" });
  const entries = await linuxApps.load();
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.error === undefined));
  assert.deepEqual(entries.filter(entry => entry.applicable).map(entry => entry.recipe!.platform), ["linux"]);
  assert.equal(await readFile(existing, "utf8"), content);
});

test("profile import adds both same-name Linux and Darwin recipes", async t => {
  const { home, operations, apps } = await fixture(t);
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [
    { ...recipe, name: "foo", platform: "linux" }, { ...recipe, name: "foo", platform: "darwin" },
  ] });
  const plan = await buildProfileImport(input, operations, apps);
  assert.deepEqual(plan.items.map(item => item.status), ["add", "add"]);
  assert.deepEqual((await applyProfileImport(plan, operations, apps, true, () => {}, { homeDirectory: home })).map(result => result.status), ["added", "added"]);
  const entries = await createAppOperations({ recipesDirectory: apps.directory, platform: "linux" }).load();
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.error === undefined));
});

test("invalid recipe JSON reserves only its overlapping name and platform", async t => {
  const { operations, apps } = await fixture(t);
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "invalid-foo.json"), JSON.stringify({ name: "foo", platform: "linux" }));
  const input = parseProfile({ ...profile, sources: [], skills: [], apps: [
    { ...recipe, name: "foo", platform: "linux" }, { ...recipe, name: "foo", platform: "windows" },
  ] });
  assert.deepEqual((await buildProfileImport(input, operations, apps)).items.map(item => item.status), ["conflict", "add"]);
});

test("unknown-name recipe warnings include raw JSON read or parse failure details", async t => {
  const { operations, apps } = await fixture(t);
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "broken.json"), "{broken JSON");
  await mkdir(path.join(apps.directory, "unreadable.json"));
  const plan = await buildProfileImport({ ...profile, sources: [], skills: [], apps: [] }, operations, apps);
  assert.match(plan.preview.join("\n"), /WARNING:.*broken\.json.*raw JSON read\/parse failed: .+; name unknown/);
  assert.match(plan.preview.join("\n"), /WARNING:.*unreadable\.json.*raw JSON read\/parse failed: .*EISDIR/);
});

test("registered Source URL spelling does not produce an unregistered-fetch warning", async t => {
  const { operations, apps } = await fixture(t);
  await operations.addGitSource("https://example.test/shared.git");
  // The public core also accepts embedders retaining the originally supplied URL spelling.
  const originalSpelling = { ...operations, listSources: async () => (await operations.listSources()).map(source =>
    source.kind === "git" ? { ...source, url: "HTTPS://EXAMPLE.TEST/shared.git///" } : source) };
  const input = parseProfile({ ...profile, sources: [], apps: [], skills: [{ ...selection,
    source: { kind: "external", url: "https://example.test/shared.git/" } }] });
  const plan = await buildProfileImport(input, originalSpelling, apps);
  assert.doesNotMatch(plan.preview.join("\n"), /will be fetched but not registered/);
  const fresh = await fixture(t);
  const registering = await buildProfileImport({ ...input, sources: [{ url: "HTTPS://EXAMPLE.TEST/shared.git///", included: true }] }, fresh.operations, fresh.apps);
  assert.equal(registering.items[0]!.status, "add");
  assert.doesNotMatch(registering.preview.join("\n"), /will be fetched but not registered/);
});
