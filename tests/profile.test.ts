import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { createAppOperations } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { buildProfileExport } from "../src/profile-export.js";
import { test } from "node:test";
import { AGENT_DEPOT_PACKAGE_VERSION } from "../src/project-manifest.js";
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
  const result = await buildProfileExport(operations, apps, { homeDirectory: home });
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
  const dependencies = { homeDirectory: home, operations, appOperations, stdout: (line: string) => stdout.push(line),
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
  assert.equal(await runCli(["export", "--out", out], {
    homeDirectory: home, operations: createSourceOperations({ statePath: path.join(home, "sources.json") }),
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
  assert.deepEqual(empty.preview, ["Preview: export portable user-global profile"]);
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
