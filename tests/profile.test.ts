import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { createAppOperations } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { buildProfileExport } from "../src/profile-export.js";
import { test } from "node:test";
import { parseProfile, serializeProfile } from "../src/profile.js";

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
};

test("portable profile round-trips Sources, selections and full cross-platform recipes", () => {
  assert.deepEqual(parseProfile(JSON.parse(serializeProfile(parseProfile(profile)))), profile);
});

test("profile rejects unknown fields, versions and nonportable content with field paths", () => {
  for (const [value, reason] of [
    [{ ...profile, format: "agent-depot-profile/v2" }, /profile.format/],
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

 test("export includes only portable managed state and recipes without running commands", async t => {
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
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps"),
    runner: async () => { throw new Error("must not execute"); } });
  await mkdir(apps.directory);
  await writeFile(path.join(apps.directory, "tool.json"), JSON.stringify(recipe));
  const result = await buildProfileExport(operations, apps);
  assert.deepEqual(result.profile.sources, [{ url: source.url, included: true }]);
  assert.deepEqual(result.profile.skills, [{ source: { kind: "builtin", id: "builtin:agent-depot" },
    path: "doctor-md-agents", version: { policy: "latest" }, hosts: ["pi", "claude"] }]);
  assert.deepEqual(result.profile.apps, [recipe]);
  assert.match(result.preview.join("\n"), /built-in Source.*always present/);
  assert.doesNotMatch(serializeProfile(result.profile), /installation|adopted|approvals/);
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
  const dependencies = { operations, appOperations, stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line) };
  assert.equal(await runCli(["export", "--source", source.id, "--no-skills", "--app", "tool"], dependencies), 0);
  const exported = parseProfile(JSON.parse(stdout.join("\n")));
  assert.deepEqual(exported.sources, [{ url: source.url, included: true }]);
  assert.deepEqual(exported.apps, [recipe]);
  assert.match(stderr.join("\n"), /Preview: export/);
  stdout.length = 0;
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
  const result = await buildProfileExport(adapted, apps);
  assert.deepEqual(result.profile.sources, []);
  assert.deepEqual(result.profile.skills, []);
  assert.match(result.preview.join("\n"), /local-path.*not portable/);
  assert.match(result.preview.join("\n"), /Excluded Skill doctor-md-agents: App-owned/);
  assert.match(result.preview.join("\n"), /Excluded App recipe broken.json/);
  assert.deepEqual((await buildProfileExport(adapted, apps, { noApps: true })).profile.skills, []);
});

test("export preserves explicit discovery choices and repeated selections", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-profile-select-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ statePath: path.join(home, "sources.json") });
  const first = await operations.addGitSource("https://example.com/first.git");
  const second = await operations.addGitSource("https://example.com/second.git");
  const apps = createAppOperations({ recipesDirectory: path.join(home, "apps") });
  const result = await buildProfileExport(operations, apps, {
    sources: [first.id, second.url], includedSourceIds: [second.id],
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
