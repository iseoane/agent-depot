import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { classifyUpdate } from "../src/package-host-plans.js";
import { runProcess } from "../src/process-runner.js";
import type { BundleDescriptor, PackageSelection } from "../src/package-model.js";
import {
  claudeMarketplaceNamesForSource,
  findInstalledBundle,
  parseClaudeMarketplaceState,
  parseClaudePluginState,
  parsePiPackagesSetting,
  piSourceIdentity,
  readHostInstallView,
  type ClaudeInstallRecord,
  type ClaudeMarketplaceRecord,
  type HostInstallView,
  type HostStateSection,
  type PiInstallRecord,
} from "../src/package-host-state.js";

const HOME = path.join(tmpdir(), "agent-depot-host-state-home");

function piDescriptor(name = "pstack-claude"): BundleDescriptor {
  return {
    host: "pi",
    coordinates: { host: "pi", root: "" },
    name,
    components: [],
    warnings: [],
    installable: true,
    manifestDigest: "a".repeat(64),
  };
}

function claudeDescriptor(name = "pstack"): BundleDescriptor {
  return {
    host: "claude",
    coordinates: { host: "claude", marketplaceRoot: "", pluginName: name },
    name,
    components: [],
    warnings: [],
    installable: true,
    manifestDigest: "b".repeat(64),
  };
}

function piSelection(url: string): PackageSelection {
  return {
    host: "pi",
    root: "",
    source: { kind: "external", url, ref: "main" },
    version: { policy: "latest" },
  };
}

function claudeSelection(pluginName: string, url = "https://github.com/michael-denyer/pstack-claude"): PackageSelection {
  return {
    host: "claude",
    marketplaceRoot: "",
    pluginName,
    source: { kind: "external", url, ref: "main" },
    version: { policy: "latest" },
  };
}

function piSection(records: readonly PiInstallRecord[]): HostStateSection<PiInstallRecord> {
  return { id: "pi-settings", path: path.join(HOME, ".pi/agent/settings.json"), present: true, records };
}

function pluginSection(records: readonly ClaudeInstallRecord[]): HostStateSection<ClaudeInstallRecord> {
  return {
    id: "claude-installed-plugins",
    path: path.join(HOME, ".claude/plugins/installed_plugins.json"),
    present: true,
    records,
  };
}

function marketplaceSection(records: readonly ClaudeMarketplaceRecord[]): HostStateSection<ClaudeMarketplaceRecord> {
  return {
    id: "claude-known-marketplaces",
    path: path.join(HOME, ".claude/plugins/known_marketplaces.json"),
    present: true,
    records,
  };
}

function viewWith(parts: Partial<HostInstallView>): HostInstallView {
  return {
    pi: piSection([]),
    claudePlugins: pluginSection([]),
    claudeMarketplaces: marketplaceSection([]),
    ...parts,
  };
}

function installRecord(overrides: Partial<ClaudeInstallRecord> = {}): ClaudeInstallRecord {
  return {
    installId: "pstack@pstack-claude",
    pluginName: "pstack",
    marketplace: "pstack-claude",
    scope: "user",
    installPath: "/cache/pstack-claude/pstack/0.9.69",
    version: "0.9.69",
    drifted: false,
    ...overrides,
  };
}

function marketplaceRecord(overrides: Partial<ClaudeMarketplaceRecord> = {}): ClaudeMarketplaceRecord {
  return {
    name: "pstack-claude",
    source: { kind: "github", repo: "michael-denyer/pstack-claude" },
    installLocation: "/marketplaces/pstack-claude",
    ...overrides,
  };
}

test("host state defaults to the isolated test home instead of inherited Pi state", async () => {
  const paths: string[] = [];
  await readHostInstallView({
    readHostStateFile: async (filePath) => {
      paths.push(filePath);
      throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    },
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(paths.includes(path.join(process.env.HOME!, ".pi", "agent", "settings.json")), true);
});

test("the observed Pi settings shapes parse into identity, pin, and object-form records", () => {
  const records = parsePiPackagesSetting({
    packages: [
      "npm:pi-mcp-adapter",
      "npm:@ryan_nookpi/pi-extension-codex-fast-mode@0.2.8",
      "git:github.com/algal/pi-openai-server-compaction@c6d593087709e9481223dc6c6c2269b371b5e055",
      { source: "npm:@juicesharp/rpiv-ask-user-question", extensions: [] },
      "git:github.com/michael-denyer/pstack-claude",
    ],
  });
  assert.deepEqual(
    records.map((record) => [record.identity, record.pin, record.commit, record.objectForm, record.drifted]),
    [
      ["npm:pi-mcp-adapter", undefined, undefined, false, false],
      ["npm:@ryan_nookpi/pi-extension-codex-fast-mode", "0.2.8", undefined, false, false],
      [
        "git:github.com/algal/pi-openai-server-compaction",
        "c6d593087709e9481223dc6c6c2269b371b5e055",
        "c6d593087709e9481223dc6c6c2269b371b5e055",
        false,
        false,
      ],
      ["npm:@juicesharp/rpiv-ask-user-question", undefined, undefined, true, false],
      ["git:github.com/michael-denyer/pstack-claude", undefined, undefined, false, false],
    ],
  );
});

test("a drifted Pi entry becomes a drifted record rather than a throw", () => {
  const records = parsePiPackagesSetting({ packages: [42, null, { extensions: [] }, ""] });
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.drifted, true);
    assert.equal(record.source, "");
  }
});

test("a Pi settings value with no packages array yields no records", () => {
  assert.deepEqual(parsePiPackagesSetting({ theme: "light" }), []);
  assert.deepEqual(parsePiPackagesSetting("not an object"), []);
});

test("the observed Claude installed_plugins.json v2 and v1 shapes parse", () => {
  const v2 = parseClaudePluginState({
    version: 2,
    plugins: {
      "demo-plugin@probe-marketplace": [
        {
          scope: "user",
          installPath: "/tmp/home/plugins/cache/probe-marketplace/demo-plugin/9.9.9",
          version: "9.9.9",
          installedAt: "2026-10-05T19:08:14.366Z",
          lastUpdated: "2026-10-05T19:08:14.366Z",
        },
      ],
    },
  });
  assert.deepEqual(v2, [{
    installId: "demo-plugin@probe-marketplace",
    pluginName: "demo-plugin",
    marketplace: "probe-marketplace",
    scope: "user",
    installPath: "/tmp/home/plugins/cache/probe-marketplace/demo-plugin/9.9.9",
    version: "9.9.9",
    drifted: false,
  }]);

  const v1 = parseClaudePluginState({
    plugins: {
      "demo-plugin@probe-marketplace": {
        scope: "user",
        installPath: "/cache/demo",
        version: "1.0.0",
        gitCommitSha: "c6d593087709e9481223dc6c6c2269b371b5e055",
      },
    },
  });
  assert.deepEqual(v1, [{
    installId: "demo-plugin@probe-marketplace",
    pluginName: "demo-plugin",
    marketplace: "probe-marketplace",
    scope: "user",
    installPath: "/cache/demo",
    version: "1.0.0",
    commit: "c6d593087709e9481223dc6c6c2269b371b5e055",
    drifted: false,
  }]);
});

test("an unknown Claude install shape becomes a drifted record", () => {
  const records = parseClaudePluginState({
    plugins: {
      "demo-plugin@probe-marketplace": [{ scope: "user" }, { scope: 7, installPath: 3 }],
      "no-marketplace-separator": { scope: "user", installPath: "/cache/x" },
    },
  });
  assert.equal(records.length, 3);
  assert.equal(records[0].pluginName, "demo-plugin");
  assert.equal(records[1].drifted, true);
  assert.equal(records[2].drifted, true);
  assert.deepEqual(parseClaudePluginState({ plugins: "nope" }), []);
  assert.deepEqual(parseClaudePluginState("nope"), []);
});

test("the observed known_marketplaces.json shapes parse into typed sources", () => {
  const records = parseClaudeMarketplaceState({
    "probe-marketplace": {
      source: { source: "directory", path: "/tmp/ccstate-probe/fixture" },
      installLocation: "/tmp/ccstate-probe/fixture",
      lastUpdated: "2026-10-05T19:08:10.527Z",
    },
    "github-marketplace": {
      source: { source: "github", repo: "owner/repo", ref: "main" },
      installLocation: "/marketplaces/github-marketplace",
      autoUpdate: false,
    },
    "url-marketplace": {
      source: { source: "url", url: "https://example.com/marketplace.json" },
      installLocation: "/marketplaces/url-marketplace.json",
    },
    "odd-marketplace": { source: { something: "else" }, installLocation: "/marketplaces/odd" },
  });
  assert.deepEqual(records, [
    {
      name: "probe-marketplace",
      source: { kind: "directory", path: "/tmp/ccstate-probe/fixture" },
      installLocation: "/tmp/ccstate-probe/fixture",
      lastUpdated: "2026-10-05T19:08:10.527Z",
    },
    {
      name: "github-marketplace",
      source: { kind: "github", repo: "owner/repo", ref: "main" },
      installLocation: "/marketplaces/github-marketplace",
      autoUpdate: false,
    },
    {
      name: "url-marketplace",
      source: { kind: "url", url: "https://example.com/marketplace.json" },
      installLocation: "/marketplaces/url-marketplace.json",
    },
    {
      name: "odd-marketplace",
      source: { kind: "unknown", raw: JSON.stringify({ something: "else" }) },
      installLocation: "/marketplaces/odd",
    },
  ]);
});

test("readHostInstallView reads the three host files at their home-relative paths", async () => {
  const home = path.join(tmpdir(), "agent-depot-injected-home");
  const contents = new Map<string, string>([
    [path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["git:github.com/owner/repo"] })],
    [
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "demo-plugin@probe-marketplace": [installRecord({ pluginName: "demo-plugin", marketplace: "probe-marketplace" })] } }),
    ],
    [
      path.join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({ "probe-marketplace": marketplaceRecord({ name: "probe-marketplace", source: { kind: "github", repo: "owner/repo" } }) }),
    ],
  ]);
  const paths: string[] = [];
  const view = await readHostInstallView({
    homeDirectory: home,
    readHostStateFile: async (filePath) => {
      paths.push(filePath);
      const content = contents.get(filePath);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: "ENOENT" });
      }
      return content;
    },
  });

  assert.deepEqual(paths.sort(), [...contents.keys()].sort());
  assert.equal(view.pi.records[0].identity, "git:github.com/owner/repo");
  assert.equal(view.claudePlugins.records[0].pluginName, "demo-plugin");
  assert.equal(view.claudeMarketplaces.records[0].name, "probe-marketplace");
  assert.equal(view.pi.issue, undefined);
});

test("a missing host file is an empty section, not an error", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-missing-home-"));
  try {
    const view = await readHostInstallView({ homeDirectory: home });
    for (const section of [view.pi, view.claudePlugins, view.claudeMarketplaces]) {
      assert.equal(section.present, false);
      assert.equal(section.issue, undefined);
      assert.deepEqual(section.records, []);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("drifted JSON and unreadable files degrade to an issue and never throw", async () => {
  const home = path.join(tmpdir(), "agent-depot-drifted-home");
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  const pluginsPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const view = await readHostInstallView({
    homeDirectory: home,
    readHostStateFile: async (filePath) => {
      if (filePath === settingsPath) {
        return "{ not json";
      }
      if (filePath === pluginsPath) {
        return JSON.stringify({ plugins: "nope" });
      }
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  });

  assert.equal(view.pi.present, true);
  assert.ok(view.pi.issue?.includes(settingsPath));
  assert.ok(view.pi.issue?.includes("not valid JSON"));
  assert.deepEqual(view.pi.records, []);

  assert.ok(view.claudePlugins.issue?.includes("not a JSON object"));
  assert.ok(view.claudeMarketplaces.issue?.includes("could not be read"));
  assert.ok(view.claudeMarketplaces.issue?.includes("EACCES"));
});

test("a read-only host home is read without writing anything", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-readonly-home-"));
  const piDir = path.join(home, ".pi", "agent");
  const claudeDir = path.join(home, ".claude", "plugins");
  await mkdir(piDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/owner/repo"] }), "utf8");
  await writeFile(path.join(claudeDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }), "utf8");
  await writeFile(path.join(claudeDir, "known_marketplaces.json"), "{}", "utf8");
  const before = await snapshotTree(home);

  for (const directory of [home, piDir, claudeDir]) {
    await chmod(directory, 0o500);
  }
  try {
    const view = await readHostInstallView({ homeDirectory: home });
    assert.equal(view.pi.records.length, 1);
    assert.equal(view.claudePlugins.records.length, 0);
    assert.deepEqual(await snapshotTree(home), before);
  } finally {
    for (const directory of [home, piDir, claudeDir]) {
      await chmod(directory, 0o700);
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi identity is the repository URL without the ref, and never npm", () => {
  assert.equal(piSourceIdentity({ kind: "external", url: "https://github.com/owner/repo", ref: "main" }), "git:github.com/owner/repo");
  assert.equal(piSourceIdentity({ kind: "external", url: "https://github.com/owner/repo.git" }), "git:github.com/owner/repo");
  assert.equal(piSourceIdentity({ kind: "builtin", id: "builtin:agent-depot" }), undefined);
  assert.equal(piSourceIdentity({ kind: "external", path: "./local" }), undefined);

  const view = viewWith({ pi: piSection(parsePiPackagesSetting({ packages: ["npm:@owner/tool@1.0.0"] })) });
  assert.deepEqual(findInstalledBundle(view, piDescriptor("tool"), piSelection("https://github.com/owner/tool")), { kind: "absent" });
});

test("findInstalledBundle uses the verified checkout HEAD, not the settings pin", () => {
  const records = parsePiPackagesSetting({
    packages: [
      "git:github.com/owner/repo@c6d593087709e9481223dc6c6c2269b371b5e055",
      "git:github.com/other/unrelated",
    ],
  }).map((record) => record.identity === "git:github.com/owner/repo"
    ? { ...record, checkoutCommit: "d".repeat(40), checkoutVersion: "1.2.3" }
    : record);
  const view = viewWith({ pi: piSection(records) });
  assert.deepEqual(
    findInstalledBundle(view, piDescriptor("repo"), piSelection("https://github.com/owner/repo")),
    { kind: "installed", version: "1.2.3", commit: "d".repeat(40) },
  );
  assert.deepEqual(
    findInstalledBundle(view, piDescriptor("repo"), piSelection("https://github.com/owner/missing")),
    { kind: "absent" },
  );
});

test("a Pi descriptor root must match the selected root exactly", () => {
  const view = viewWith({
    pi: piSection([{ ...parsePiPackagesSetting({ packages: ["git:github.com/owner/repo"] })[0], checkoutCommit: "a".repeat(40) }]),
  });
  const selection = { ...piSelection("https://github.com/owner/repo"), root: "nested" };
  const evidence = findInstalledBundle(view, piDescriptor("repo"), selection);
  assert.deepEqual(evidence, { kind: "unknown", reason: "the Pi bundle root and the selection disagree" });
});

test("a Pi settings record proves membership when checkout version evidence is unavailable", () => {
  const view = viewWith({ pi: piSection(parsePiPackagesSetting({ packages: ["git:github.com/owner/repo"] })) });
  const evidence = findInstalledBundle(view, piDescriptor("repo"), piSelection("https://github.com/owner/repo"));
  assert.equal(evidence.kind, "installed");
  if (evidence.kind === "installed") {
    assert.equal(evidence.version, undefined);
    assert.match(evidence.reason ?? "", /checkout could not be verified/u);
  }
});

test("a drifted Pi entry or an unreadable file makes the Pi lookup unknown", () => {
  const drifted = viewWith({ pi: piSection(parsePiPackagesSetting({ packages: [{ extensions: [] }] })) });
  const unknown = findInstalledBundle(drifted, piDescriptor("repo"), piSelection("https://github.com/owner/repo"));
  assert.equal(unknown.kind, "unknown");

  const unreadable = viewWith({
    pi: { id: "pi-settings", path: "/home/.pi/agent/settings.json", present: true, records: [], issue: "settings.json is not valid JSON" },
  });
  const failed = findInstalledBundle(unreadable, piDescriptor("repo"), piSelection("https://github.com/owner/repo"));
  assert.deepEqual(failed, { kind: "unknown", reason: "settings.json is not valid JSON" });
});

test("Claude marketplace names resolve from the record's own source", () => {
  const section = marketplaceSection([
    marketplaceRecord({ name: "pstack-claude", source: { kind: "github", repo: "michael-denyer/pstack-claude" } }),
    marketplaceRecord({ name: "local-copy", source: { kind: "directory", path: "/srv/local-copy" } }),
  ]);
  assert.deepEqual(
    claudeMarketplaceNamesForSource(section, { kind: "external", url: "https://github.com/michael-denyer/pstack-claude", ref: "main" }),
    ["pstack-claude"],
  );
  assert.deepEqual(
    claudeMarketplaceNamesForSource(section, { kind: "external", url: "https://github.com/owner/other" }),
    [],
  );
  assert.deepEqual(
    claudeMarketplaceNamesForSource(section, { kind: "external", path: "/srv/local-copy" }),
    ["local-copy"],
  );
});

test("findInstalledBundle attributes a Claude install only through its marketplace binding", () => {
  const bound = viewWith({
    claudePlugins: pluginSection([installRecord()]),
    claudeMarketplaces: marketplaceSection([marketplaceRecord()]),
  });
  assert.deepEqual(
    findInstalledBundle(bound, claudeDescriptor("pstack"), claudeSelection("pstack")),
    { kind: "installed", version: "0.9.69" },
  );

  const projectScope = viewWith({
    claudePlugins: pluginSection([installRecord({ scope: "project", installPath: "/project/.claude/plugins/pstack" })]),
    claudeMarketplaces: marketplaceSection([marketplaceRecord()]),
  });
  assert.deepEqual(findInstalledBundle(projectScope, claudeDescriptor("pstack"), claudeSelection("pstack")), { kind: "absent" });

  const unbound = viewWith({ claudePlugins: pluginSection([installRecord()]) });
  const evidence = findInstalledBundle(unbound, claudeDescriptor("pstack"), claudeSelection("pstack"));
  assert.equal(evidence.kind, "unknown");

  const absent = viewWith({ claudeMarketplaces: marketplaceSection([marketplaceRecord()]) });
  assert.deepEqual(findInstalledBundle(absent, claudeDescriptor("pstack"), claudeSelection("pstack")), { kind: "absent" });
});

test("a clean Pi checkout yields its HEAD and package manifest version", async () => {
  const fixture = await piCheckoutFixture();
  try {
    const view = await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });
    const evidence = findInstalledBundle(view, piDescriptor("repo"), piSelection(fixture.url));
    assert.deepEqual(evidence, { kind: "installed", version: "1.2.3", commit: fixture.commit });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Pi checkout origin mismatch blocks version evidence while local modifications only block commit evidence", async () => {
  const fixture = await piCheckoutFixture();
  try {
    await git(fixture.checkoutPath, ["remote", "set-url", "origin", "https://github.com/other/repo"]);
    const readView = () => readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });
    const wrongOrigin = findInstalledBundle(await readView(), piDescriptor("repo"), piSelection(fixture.url));
    assert.equal(wrongOrigin.kind, "installed");
    if (wrongOrigin.kind === "installed") {
      assert.equal(wrongOrigin.version, undefined);
      assert.match(wrongOrigin.reason ?? "", /origin does not match/u);
    }

    await git(fixture.checkoutPath, ["remote", "set-url", "origin", fixture.url]);
    await writeFile(path.join(fixture.checkoutPath, "untracked.txt"), "local change", "utf8");
    const modified = findInstalledBundle(await readView(), piDescriptor("repo"), piSelection(fixture.url));
    assert.deepEqual(modified, {
      kind: "installed",
      version: "1.2.3",
      reason: "Pi reports this Package installed, but the Pi Git checkout has local modifications. Update assessment is unavailable; inspect the checkout before updating.",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("only a matching root-only untracked npm lockfile permits Pi update comparison", async () => {
  const fixture = await piCheckoutFixture();
  try {
    await git(fixture.checkoutPath, ["rm", "package-lock.json"]);
    await git(fixture.checkoutPath, ["commit", "-m", "remove tracked lock"]);
    const commit = await gitOutput(fixture.checkoutPath, ["rev-parse", "HEAD"]);
    const readEvidence = async () => findInstalledBundle(await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    }), piDescriptor("repo"), piSelection(fixture.url));
    const lockPath = path.join(fixture.checkoutPath, "package-lock.json");
    const root = { name: "repo", version: "1.2.3" };
    const lock = { ...root, lockfileVersion: 3, requires: true, packages: { "": root } };
    const bytes = JSON.stringify(lock);
    await writeFile(lockPath, bytes);
    assert.deepEqual(await readEvidence(), { kind: "installed", version: "1.2.3", commit });
    assert.equal(await readFile(lockPath, "utf8"), bytes);
    assert.equal(classifyUpdate(await readEvidence(), { kind: "manifest-version", version: "1.2.3", declaredBy: "bundle" }, "b".repeat(40), true), "update available");
    for (const invalid of [
      { ...lock, version: "9.9.9" },
      { ...lock, packages: { "": { ...root, dependencies: { other: "*" } } } },
      { ...lock, packages: { "": root, "node_modules/other": { version: "1.0.0" } } },
    ]) {
      await writeFile(lockPath, JSON.stringify(invalid));
      const evidence = await readEvidence();
      assert.equal(evidence.kind, "installed");
      if (evidence.kind === "installed") assert.equal(evidence.commit, undefined);
    }
    await writeFile(lockPath, bytes);
    await writeFile(path.join(fixture.checkoutPath, "local.txt"), "local change");
    const dirty = await readEvidence();
    if (dirty.kind === "installed") assert.equal(dirty.commit, undefined);
    else assert.fail("membership must remain installed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("npm's generated root lock with matching bin metadata is verified clean checkout evidence (#50)", async () => {
  const fixture = await piCheckoutFixture();
  try {
    const manifest = { name: "isswf-pi-resources", version: "1.5.0", bin: { isswf: "tools/isswf.mjs" } };
    const commit = await commitManifestWithoutLock(fixture.checkoutPath, manifest);
    const lockPath = path.join(fixture.checkoutPath, "package-lock.json");
    const lockFor = (root: Record<string, unknown>, extra: Record<string, unknown> = {}): string => `${JSON.stringify({
      name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { "": root }, ...extra,
    }, null, 2)}\n`;
    const readEvidence = async () => findInstalledBundle(await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    }), piDescriptor("repo"), piSelection(fixture.url));
    const expectBlocked = async (label: string): Promise<void> => {
      const evidence = await readEvidence();
      assert.equal(evidence.kind, "installed", label);
      if (evidence.kind === "installed") {
        assert.equal(evidence.commit, undefined, label);
        assert.match(evidence.reason ?? "", /local modifications/u, label);
      }
    };

    // The exact lockfile reported in #50: a verified HEAD commit with no reason is what the Package flow persists.
    const issueLock = `{
  "name": "isswf-pi-resources",
  "version": "1.5.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "isswf-pi-resources",
      "version": "1.5.0",
      "bin": { "isswf": "tools/isswf.mjs" }
    }
  }
}
`;
    await writeFile(lockPath, issueLock);
    assert.deepEqual(await readEvidence(), { kind: "installed", version: "1.5.0", commit });
    assert.equal(await readFile(lockPath, "utf8"), issueLock);
    assert.equal(classifyUpdate(await readEvidence(), { kind: "manifest-version", version: "1.5.0", declaredBy: "bundle" }, "b".repeat(40), true), "update available");

    const root = { name: manifest.name, version: manifest.version };
    for (const [label, invalid] of [
      ["mismatched bin path", lockFor({ ...root, bin: { isswf: "tools/other.mjs" } })],
      ["mismatched bin name", lockFor({ ...root, bin: { other: "tools/isswf.mjs" } })],
      ["extra bin entry", lockFor({ ...root, bin: { isswf: "tools/isswf.mjs", extra: "tools/extra.mjs" } })],
      ["missing bin entry", lockFor(root)],
      ["unnormalized bin path", lockFor({ ...root, bin: { isswf: "./tools/isswf.mjs" } })],
      ["string bin in lock", lockFor({ ...root, bin: "tools/isswf.mjs" })],
      ["unknown root metadata", lockFor({ ...root, bin: manifest.bin, hasInstallScript: true })],
      ["dependencies in lock root", lockFor({ ...root, bin: manifest.bin, dependencies: { other: "*" } })],
      ["extra lock package", lockFor({ ...root, bin: manifest.bin }, { packages: { "": { ...root, bin: manifest.bin }, "node_modules/other": { version: "1.0.0" } } })],
    ] as const) {
      await writeFile(lockPath, invalid);
      await expectBlocked(label);
    }

    // A lock that carries bin for a manifest that does not.
    await commitManifestWithoutLock(fixture.checkoutPath, { name: manifest.name, version: manifest.version });
    await writeFile(lockPath, issueLock);
    await expectBlocked("bin in lock but not in manifest");

    // A manifest that declares dependencies is more than the harmless root-only artifact.
    await commitManifestWithoutLock(fixture.checkoutPath, { ...manifest, dependencies: { other: "*" } });
    await writeFile(lockPath, issueLock);
    await expectBlocked("manifest dependencies");

    // Matching lock, but any other local change still blocks.
    const restoredCommit = await commitManifestWithoutLock(fixture.checkoutPath, manifest);
    await writeFile(lockPath, issueLock);
    assert.deepEqual(await readEvidence(), { kind: "installed", version: "1.5.0", commit: restoredCommit });
    await writeFile(path.join(fixture.checkoutPath, "local.txt"), "local change");
    await expectBlocked("other untracked file");
    await rm(path.join(fixture.checkoutPath, "local.txt"));
    await writeFile(path.join(fixture.checkoutPath, "package.json"), JSON.stringify({ ...manifest, description: "edited" }));
    await expectBlocked("tracked modification");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("npm's generated root lock normalizes a string bin to the unscoped package name", async () => {
  const fixture = await piCheckoutFixture();
  try {
    const readEvidence = async () => findInstalledBundle(await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    }), piDescriptor("repo"), piSelection(fixture.url));
    const lockPath = path.join(fixture.checkoutPath, "package-lock.json");
    const lockFor = (name: string, bin: unknown): string => JSON.stringify({
      name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0", bin } },
    });
    // Shapes below were produced by `npm install --package-lock-only` (npm 12).
    const commit = await commitManifestWithoutLock(fixture.checkoutPath, { name: "@scope/pkg", version: "1.0.0", bin: "./tools/x.mjs" });
    await writeFile(lockPath, lockFor("@scope/pkg", { pkg: "tools/x.mjs" }));
    assert.deepEqual(await readEvidence(), { kind: "installed", version: "1.0.0", commit });
    for (const wrong of [{ "@scope/pkg": "tools/x.mjs" }, { pkg: "./tools/x.mjs" }, "tools/x.mjs"]) {
      await writeFile(lockPath, lockFor("@scope/pkg", wrong));
      const evidence = await readEvidence();
      assert.equal(evidence.kind === "installed" ? evidence.commit : "unexpected", undefined);
    }
    // Object-form targets lose a leading ./ too.
    const objectCommit = await commitManifestWithoutLock(fixture.checkoutPath, { name: "plain", version: "1.0.0", bin: { tool: "./t/x.mjs" } });
    await writeFile(lockPath, lockFor("plain", { tool: "t/x.mjs" }));
    assert.deepEqual(await readEvidence(), { kind: "installed", version: "1.0.0", commit: objectCommit });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a modified tracked Pi lockfile keeps the HEAD version but no update identity", async () => {
  const fixture = await piCheckoutFixture();
  try {
    await writeFile(path.join(fixture.checkoutPath, "package-lock.json"), '{"lockfileVersion":3,"local":true}\n', "utf8");
    const view = await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });
    assert.deepEqual(findInstalledBundle(view, piDescriptor("repo"), piSelection(fixture.url)), {
      kind: "installed",
      version: "1.2.3",
      reason: "Pi reports this Package installed, but the Pi Git checkout has local modifications. Update assessment is unavailable; inspect the checkout before updating.",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a modified working-tree Pi manifest cannot replace HEAD version evidence", async () => {
  const fixture = await piCheckoutFixture();
  try {
    await writeFile(path.join(fixture.checkoutPath, "package.json"), JSON.stringify({ name: "repo", version: "2.0.0" }), "utf8");
    const view = await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });
    const installed = findInstalledBundle(view, piDescriptor("repo"), piSelection(fixture.url));
    assert.deepEqual(installed, {
      kind: "installed",
      version: "1.2.3",
      reason: "Pi reports this Package installed, but the Pi Git checkout has local modifications. Update assessment is unavailable; inspect the checkout before updating.",
    });
    assert.equal(classifyUpdate(
      installed,
      { kind: "manifest-version", version: "2.0.0", declaredBy: "bundle" },
      "b".repeat(40),
    ), "unknown");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an untracked Pi manifest cannot provide installed version evidence", async () => {
  const fixture = await piCheckoutFixture();
  try {
    await git(fixture.checkoutPath, ["rm", "package.json"]);
    await git(fixture.checkoutPath, ["commit", "-m", "remove manifest"]);
    await writeFile(path.join(fixture.checkoutPath, "package.json"), JSON.stringify({ name: "repo", version: "9.9.9" }), "utf8");
    const view = await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });
    const evidence = findInstalledBundle(view, piDescriptor("repo"), piSelection(fixture.url));
    assert.equal(evidence.kind, "installed");
    if (evidence.kind === "installed") {
      assert.equal(evidence.version, undefined);
      assert.match(evidence.reason ?? "", /checkout could not be read safely/u);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a Pi checkout symlink preserves installation membership but cannot provide version evidence", async () => {
  const fixture = await piCheckoutFixture();
  try {
    const outside = path.join(fixture.root, "outside-checkout");
    await rename(fixture.checkoutPath, outside);
    await symlink(outside, fixture.checkoutPath, "dir");
    const view = await readHostInstallView({
      homeDirectory: fixture.home,
      piAgentDirectory: fixture.agentDirectory,
      readHostStateFile: async (filePath) => {
        if (filePath === fixture.settingsPath) return JSON.stringify({ packages: [fixture.source] });
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });
    const evidence = findInstalledBundle(view, piDescriptor("repo"), piSelection(fixture.url));
    assert.equal(evidence.kind, "installed");
    if (evidence.kind === "installed") {
      assert.equal(evidence.commit, undefined);
      assert.match(evidence.reason ?? "", /symbolic link/u);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("findInstalledBundle refuses a descriptor that disagrees with the selection host", () => {
  const evidence = findInstalledBundle(viewWith({}), claudeDescriptor("pstack"), piSelection("https://github.com/owner/repo"));
  assert.equal(evidence.kind, "unknown");
});

async function piCheckoutFixture(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly agentDirectory: string;
  readonly checkoutPath: string;
  readonly settingsPath: string;
  readonly url: string;
  readonly source: string;
  readonly commit: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-pi-checkout-"));
  const home = path.join(root, "home");
  const agentDirectory = path.join(home, ".pi", "agent");
  const checkoutPath = path.join(agentDirectory, "git", "github.com", "owner", "repo");
  const settingsPath = path.join(agentDirectory, "settings.json");
  const url = "https://github.com/owner/repo";
  const source = "git:github.com/owner/repo";
  await mkdir(checkoutPath, { recursive: true });
  await writeFile(path.join(checkoutPath, "package.json"), JSON.stringify({ name: "repo", version: "1.2.3" }), "utf8");
  await git(checkoutPath, ["init"]);
  await git(checkoutPath, ["config", "user.email", "fixture@example.test"]);
  await git(checkoutPath, ["config", "user.name", "Fixture"]);
  await git(checkoutPath, ["remote", "add", "origin", url]);
  await writeFile(path.join(checkoutPath, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  await git(checkoutPath, ["add", "package.json", "package-lock.json"]);
  await git(checkoutPath, ["commit", "-m", "fixture"]);
  const commit = await gitOutput(checkoutPath, ["rev-parse", "HEAD"]);
  return { root, home, agentDirectory, checkoutPath, settingsPath, url, source, commit };
}

async function commitManifestWithoutLock(checkoutPath: string, manifest: Record<string, unknown>): Promise<string> {
  await rm(path.join(checkoutPath, "package-lock.json"), { force: true });
  await writeFile(path.join(checkoutPath, "package.json"), JSON.stringify(manifest), "utf8");
  await git(checkoutPath, ["rm", "--cached", "--ignore-unmatch", "--quiet", "package-lock.json"]);
  await git(checkoutPath, ["add", "package.json"]);
  await git(checkoutPath, ["commit", "--allow-empty", "-m", "manifest"]);
  return gitOutput(checkoutPath, ["rev-parse", "HEAD"]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runProcess("git", ["-C", cwd, ...args], { timeoutMs: 3000 });
  assert.equal(result.code, 0, result.stderr);
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { captureStdout: true, timeoutMs: 3000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.toString("utf8").trim();
}

async function snapshotTree(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    const items = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const item of items) {
      const rel = relative === "" ? item.name : `${relative}/${item.name}`;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) {
        entries.push(`dir ${rel}`);
        await walk(absolute, rel);
      } else {
        entries.push(`file ${rel} ${await readFile(absolute, "utf8")}`);
      }
    }
  }
  await walk(root, "");
  return entries;
}
