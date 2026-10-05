import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  buildComponentInventory,
  bundleOwnedSkillMatcher,
  claudeMarketplaceName,
  discoverBundlesInSnapshot,
  PackageManifestError,
  parseClaudeMarketplace,
  parseClaudePluginManifest,
  parsePiPackageManifest,
} from "../src/package-bundles.js";
import { DEFERRED_COMPONENT_KINDS, type BundleDescriptor } from "../src/package-model.js";
import type { SourceContentFile } from "../src/skill-discovery.js";

async function readFixtureFiles(fixtureName: string): Promise<readonly SourceContentFile[]> {
  const root = path.resolve("tests", "fixtures", "packages", fixtureName);
  const files: SourceContentFile[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), rel);
      } else if (entry.isFile()) {
        files.push({ path: rel, content: await readFile(path.join(directory, entry.name), "utf8") });
      }
    }
  }
  await walk(root, "");
  return files;
}

test("a dual-format pstack repository yields one Pi and one Claude descriptor over the shared skills", async () => {
  const descriptors = discoverBundlesInSnapshot(await readFixtureFiles("pstack"), {});
  assert.equal(descriptors.length, 2);
  const pi = descriptors.find((descriptor) => descriptor.host === "pi");
  const claude = descriptors.find((descriptor) => descriptor.host === "claude");
  assert.ok(pi);
  assert.ok(claude);

  const piSkills = pi.components.find((component) => component.kind === "skills");
  const claudeSkills = claude.components.find((component) => component.kind === "skills");
  assert.deepEqual(piSkills?.paths, ["plugins/pstack/skills"]);
  assert.deepEqual(claudeSkills?.paths, ["plugins/pstack/skills"]);
  assert.deepEqual(piSkills?.skillNames, ["how", "poteto-mode"]);
  assert.deepEqual(claudeSkills?.skillNames, ["how", "poteto-mode"]);
});

test("the Claude descriptor reports twelve agents as deferred and no skill is folded in", async () => {
  const claude = discoverBundlesInSnapshot(await readFixtureFiles("pstack"), {})
    .find((descriptor) => descriptor.host === "claude");
  assert.ok(claude);
  const deferred = new Set<string>(DEFERRED_COMPONENT_KINDS);
  const agents = claude.components.find((component) => component.kind === "agents");
  assert.ok(agents);
  assert.equal(agents.ownership, "host-only");
  assert.equal(agents.paths.length, 12);
  assert.equal(deferred.has("agents"), true);

  const skills = claude.components.find((component) => component.kind === "skills");
  assert.equal(skills?.ownership, "skill-category");
  assert.equal(deferred.has("skills"), false);
  for (const component of claude.components) {
    if (deferred.has(component.kind)) {
      assert.equal(component.ownership, "host-only");
    }
  }
});

test("a Pi package with no pi key discovers the same inventory as the explicit manifest", async () => {
  const explicit = discoverBundlesInSnapshot(await readFixtureFiles("pi-explicit"), {})[0];
  const conventional = discoverBundlesInSnapshot(await readFixtureFiles("pi-conventional"), {})[0];
  assert.ok(explicit);
  assert.ok(conventional);
  assert.deepEqual(conventional.components, explicit.components);
  assert.deepEqual(explicit.components.map((component) => component.kind), ["skills", "extensions", "prompts", "themes"]);
  assert.deepEqual(explicit.components[0], {
    kind: "skills",
    ownership: "skill-category",
    effect: "instruction",
    paths: ["skills"],
    skillNames: ["foo"],
  });
});

test("manifestDigest changes when any manifest byte changes and is stable across a rebuild", async () => {
  const files = await readFixtureFiles("pstack");
  const packageRaw = files.find((file) => file.path === "package.json")!.content;
  const first = parsePiPackageManifest(packageRaw, "");
  const second = parsePiPackageManifest(packageRaw, "");
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.notEqual(first.manifestDigest, parsePiPackageManifest(`${packageRaw}\n`, "").manifestDigest);

  const marketplaceRaw = files.find((file) => file.path === ".claude-plugin/marketplace.json")!.content;
  const pluginRaw = files.find((file) => file.path === "plugins/pstack/.claude-plugin/plugin.json")!.content;
  const bound = parseClaudeMarketplace(marketplaceRaw, "", (root) => root === "plugins/pstack" ? pluginRaw : undefined)[0];
  const changed = parseClaudeMarketplace(marketplaceRaw, "", (root) =>
    root === "plugins/pstack" ? `${pluginRaw}\n` : undefined)[0];
  assert.notEqual(bound.manifestDigest, changed.manifestDigest);
});

test("a scoped Source refuses a Pi package with a warning rather than a throw", () => {
  const files: readonly SourceContentFile[] = [
    { path: "plugins/pstack/package.json", content: JSON.stringify({ name: "p", pi: { skills: ["./skills"] } }) },
    { path: "plugins/pstack/skills/a/SKILL.md", content: "---\nname: a\ndescription: a\n---\n" },
  ];
  const descriptors = discoverBundlesInSnapshot(files, { directory: "plugins/pstack" });
  assert.equal(descriptors.length, 1);
  assert.ok(descriptors[0].warnings.some((warning) => warning.includes("scoped Source")));
});

test("a Pi manifest below the scope root is not a bundle", () => {
  const files: readonly SourceContentFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "root" }) },
    { path: "nested/package.json", content: JSON.stringify({ name: "nested", pi: { skills: ["./skills"] } }) },
  ];
  const descriptors = discoverBundlesInSnapshot(files, {});
  assert.deepEqual(descriptors, []);
});

test("a Claude plugin with no in-repo marketplace binding is reported but not installable", async () => {
  const descriptors = discoverBundlesInSnapshot(await readFixtureFiles("claude-unbound"), {});
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].host, "claude");
  assert.ok(descriptors[0].warnings.some((warning) => warning.includes("no in-repo marketplace binding")));
});

test("a bundle-declared command marketplace source yields a warning", () => {
  const marketplaceRaw = JSON.stringify({ name: "m", plugins: [{ name: "p", source: { command: "echo hi" } }] });
  const descriptors = parseClaudeMarketplace(marketplaceRaw, "", () => undefined);
  assert.equal(descriptors.length, 1);
  assert.ok(descriptors[0].warnings.some((warning) => warning.includes("command source")));
});

test("a marketplace source outside the repository yields a warning", () => {
  const marketplaceRaw = JSON.stringify({ name: "m", plugins: [{ name: "p", source: { github: { repo: "owner/repo" } } }] });
  const descriptors = parseClaudeMarketplace(marketplaceRaw, "", () => undefined);
  assert.ok(descriptors[0].warnings.some((warning) => warning.includes("outside the registered repository")));
});

test("the marketplace entry version overrides the plugin manifest version", () => {
  const pluginRaw = JSON.stringify({ name: "p", version: "0.9.0", agents: ["./a.md"] });
  const marketplaceRaw = JSON.stringify({ name: "m", plugins: [{ name: "p", source: "./p", version: "1.0.0" }] });
  const descriptor = parseClaudeMarketplace(marketplaceRaw, "", (root) => root === "p" ? pluginRaw : undefined)[0];
  assert.deepEqual(descriptor.version, { kind: "manifest-version", version: "1.0.0", declaredBy: "marketplace-entry" });
  assert.equal(descriptor.name, "p");
  assert.deepEqual(descriptor.coordinates, { host: "claude", marketplaceRoot: "", pluginName: "p" });
});

test("the owned-skill matcher applies the lifecycle segment filter", async () => {
  const descriptors = discoverBundlesInSnapshot(await readFixtureFiles("pstack"), {});
  const owned = bundleOwnedSkillMatcher(descriptors);
  assert.notEqual(owned("plugins/pstack/skills/poteto-mode"), undefined);
  assert.equal(owned("plugins/pstack/skills/deprecated/old-skill"), undefined);
  assert.equal(owned("other/loose-skill"), undefined);
});

test("buildComponentInventory surfaces deferred kinds as host-only exactly once", () => {
  const manifest = { name: "p", agents: ["./a.md"], mcpServers: ["./.mcp.json"], skills: ["./custom"] };
  const components = buildComponentInventory("claude", manifest);
  const deferred = new Set<string>(DEFERRED_COMPONENT_KINDS);
  assert.deepEqual(components.map((component) => component.kind), ["skills", "agents", "mcp-servers"]);
  const skills = components.find((component) => component.kind === "skills");
  assert.equal(skills?.ownership, "skill-category");
  assert.deepEqual(skills?.paths, ["skills", "custom"]);
  for (const component of components) {
    if (deferred.has(component.kind)) {
      assert.equal(component.ownership, "host-only");
    }
  }
});

test("parsePiPackageManifest falls back to the conventional directories without a pi key", () => {
  const descriptor = parsePiPackageManifest(JSON.stringify({ name: "p" }), "");
  assert.deepEqual(descriptor.components.map((component) => component.kind), ["skills", "extensions", "prompts", "themes"]);
  assert.deepEqual(descriptor.components.map((component) => component.paths), [["skills"], ["extensions"], ["prompts"], ["themes"]]);
});

test("malformed manifests fail closed with a PackageManifestError", () => {
  assert.throws(() => parsePiPackageManifest("{ not json", ""), PackageManifestError);
  assert.throws(() => parseClaudePluginManifest(JSON.stringify({ version: "1.0.0" }), ""), PackageManifestError);
  assert.throws(() => parseClaudeMarketplace(JSON.stringify({ name: "m" }), "", () => undefined), PackageManifestError);
});

test("every exported descriptor has a stable typed shape", () => {
  const descriptor: BundleDescriptor = parsePiPackageManifest(JSON.stringify({ name: "p", pi: { skills: ["./skills"] } }), "");
  assert.equal(descriptor.host, "pi");
  assert.equal(descriptor.name, "p");
  assert.equal(typeof descriptor.manifestDigest, "string");
  assert.equal(descriptor.manifestDigest.length, 64);
});

test("the marketplace name is read from the marketplace's own manifest", () => {
  assert.equal(claudeMarketplaceName(JSON.stringify({ name: "pstack-claude", owner: { name: "Example" } })), "pstack-claude");
  assert.equal(claudeMarketplaceName(JSON.stringify({ name: "  " })), undefined);
  assert.equal(claudeMarketplaceName(JSON.stringify({ owner: { name: "Example" } })), undefined);
  assert.throws(() => claudeMarketplaceName("{ not json"), PackageManifestError);
});
