import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { sourceIdForUrl } from "../src/git-source.js";
import { discoverBundlesInSnapshot } from "../src/package-bundles.js";
import { readHostInstallView, type HostInstallView } from "../src/package-host-state.js";
import { packageSelectionFor, type BundleDescriptor } from "../src/package-model.js";
import { activeBundles, loadPackageOwnedSkillFilter } from "../src/package-owned-skills.js";
import type { SourceContentFile } from "../src/skill-discovery.js";
import { projectSourceOf, type Source } from "../src/sources.js";

const MATT_URL = "https://github.com/mattpocock/skills";
const PSTACK_URL = "https://github.com/iseoane/pstack";
const MATT_SOURCE: Source = { id: sourceIdForUrl(MATT_URL), kind: "git", url: MATT_URL };
const TDD_PATH = "skills/engineering/tdd";

const EMPTY_HOST_VIEW: HostInstallView = Object.freeze({
  pi: Object.freeze({ id: "pi-settings", path: "", present: false, records: Object.freeze([]) }),
  claudePlugins: Object.freeze({ id: "claude-installed-plugins", path: "", present: false, records: Object.freeze([]) }),
  claudeMarketplaces: Object.freeze({ id: "claude-known-marketplaces", path: "", present: false, records: Object.freeze([]) }),
});

async function readFixtureFiles(fixtureName: string): Promise<readonly SourceContentFile[]> {
  const root = path.resolve("tests", "fixtures", "packages", fixtureName);
  const files: SourceContentFile[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), rel);
      else if (entry.isFile()) files.push({ path: rel, content: await readFile(path.join(directory, entry.name), "utf8") });
    }
  }
  await walk(root, "");
  return files;
}

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "ad-package-ownership-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

/** The Matt fixture's one Claude bundle, as a discovered bundle and its portable selection. */
async function mattBundle(): Promise<{ readonly descriptor: BundleDescriptor; readonly source: Source }> {
  const files = await readFixtureFiles("matt-skills");
  const descriptors = discoverBundlesInSnapshot(files, {});
  assert.equal(descriptors.length, 1);
  return { descriptor: descriptors[0]!, source: MATT_SOURCE };
}

test("an unselected and absent bundle owns nothing", async () => {
  const { descriptor, source } = await mattBundle();
  const active = activeBundles([{ source: projectSourceOf(source), descriptor }], [], EMPTY_HOST_VIEW);
  assert.deepEqual(active, []);
  const owned = await loadPackageOwnedSkillFilter({ sources: [source], sourceContentAccess: { readSnapshot: async () => await readFixtureFiles("matt-skills") }, selections: [], hostView: EMPTY_HOST_VIEW });
  assert.equal(owned(TDD_PATH), undefined);
});

test("a bundle selected from its own Source owns its Skills, and an unrelated Source does not", async () => {
  const { descriptor, source } = await mattBundle();
  const bundle = { source: projectSourceOf(source), descriptor };
  const selection = packageSelectionFor(descriptor, projectSourceOf(source));
  assert.deepEqual(activeBundles([bundle], [selection], EMPTY_HOST_VIEW), [{ descriptor, reason: "selected" }]);

  const otherSelection = packageSelectionFor(descriptor, { kind: "external", url: "https://github.com/other/skills" });
  assert.deepEqual(activeBundles([bundle], [otherSelection], EMPTY_HOST_VIEW), []);
});

test("a host-proven install owns its Skills with no selection record", async () => {
  await withHome(async (home) => {
    const { descriptor, source } = await mattBundle();
    await writeJson(path.join(home, ".claude", "plugins", "known_marketplaces.json"), {
      mattpocock: { source: { source: "url", url: MATT_URL }, installLocation: path.join(home, "marketplace") },
    });
    await writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "mattpocock-skills@mattpocock": [{ scope: "user", installPath: path.join(home, "plugin"), version: "1.3.1" }] },
    });
    const view = await readHostInstallView({ homeDirectory: home });
    assert.deepEqual(activeBundles([{ source: projectSourceOf(source), descriptor }], [], view), [{ descriptor, reason: "installed" }]);
  });
});

test("an install for an unrelated Source or an unreadable host file never claims", async () => {
  await withHome(async (home) => {
    const { descriptor, source } = await mattBundle();
    await writeJson(path.join(home, ".claude", "plugins", "known_marketplaces.json"), {
      other: { source: { source: "url", url: "https://github.com/other/skills" }, installLocation: path.join(home, "marketplace") },
    });
    await writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "mattpocock-skills@other": [{ scope: "user", installPath: path.join(home, "plugin"), version: "1.3.1" }] },
    });
    const unrelated = await readHostInstallView({ homeDirectory: home });
    assert.deepEqual(activeBundles([{ source: projectSourceOf(source), descriptor }], [], unrelated), []);

    await writeFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), "{ not json");
    const unreadable = await readHostInstallView({ homeDirectory: home });
    assert.equal(unreadable.claudePlugins.issue !== undefined, true);
    assert.deepEqual(activeBundles([{ source: projectSourceOf(source), descriptor }], [], unreadable), []);
  });
});

test("a noninstallable descriptor never owns its Skills, even when a selection names it", async () => {
  const piFiles: readonly SourceContentFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "p", pi: { skills: ["./skills"] } }) },
    { path: "skills/foo/SKILL.md", content: "---\nname: foo\ndescription: foo\n---\n" },
  ];
  const refused = discoverBundlesInSnapshot(piFiles, { directory: "" })[0];
  assert.ok(refused);
  assert.equal(refused.installable, false);
  const selection = packageSelectionFor(refused, projectSourceOf(MATT_SOURCE));
  assert.deepEqual(activeBundles([{ source: projectSourceOf(MATT_SOURCE), descriptor: refused }], [selection], EMPTY_HOST_VIEW), []);
});

test("the Matt tdd Skill stays portable until its Package is active", async () => {
  const { descriptor, source } = await mattBundle();
  const access = { readSnapshot: async () => await readFixtureFiles("matt-skills") };
  const selection = packageSelectionFor(descriptor, projectSourceOf(source));

  const unselected = await loadPackageOwnedSkillFilter({ sources: [source], sourceContentAccess: access, selections: [], hostView: EMPTY_HOST_VIEW });
  assert.equal(unselected(TDD_PATH), undefined);

  const active = await loadPackageOwnedSkillFilter({ sources: [source], sourceContentAccess: access, selections: [selection], hostView: EMPTY_HOST_VIEW });
  assert.equal(active(TDD_PATH)?.name, "mattpocock-skills");
});

test("a native pstack Pi selection still owns its Skills", async () => {
  const files = await readFixtureFiles("pstack");
  const descriptor = discoverBundlesInSnapshot(files, {}).find((candidate) => candidate.host === "pi");
  assert.ok(descriptor);
  const source: Source = { id: sourceIdForUrl(PSTACK_URL), kind: "git", url: PSTACK_URL };
  const selection = packageSelectionFor(descriptor, projectSourceOf(source));
  const active = await loadPackageOwnedSkillFilter({
    sources: [source],
    sourceContentAccess: { readSnapshot: async () => files },
    selections: [selection],
    hostView: EMPTY_HOST_VIEW,
  });
  assert.equal(active("plugins/pstack/skills/poteto-mode")?.host, "pi");
});
