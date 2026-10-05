import { createHash } from "node:crypto";
import path from "node:path";

import {
  type BundleDescriptor,
  type PackageComponent,
  type PackageComponentEffect,
  type PackageComponentKind,
  type PackageComponentOwnership,
  type PackageHost,
  type PackageVersionEvidence,
} from "./package-model.js";
import {
  EXCLUDED_LIFECYCLE_SEGMENTS,
  type SourceContentFile,
} from "./skill-discovery.js";

/** A malformed manifest crossing the boundary fails closed instead of guessing. */
export class PackageManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageManifestError";
  }
}

/**
 * Reads the `pi` manifest key, or the conventional `extensions/`, `skills/`,
 * `prompts/`, and `themes/` directories when no `pi` key is present. Component
 * paths are relative to the package root; the conventional fallback declares
 * all four slots and lets discovery drop the ones with no files.
 */
export function parsePiPackageManifest(raw: string, root: string): BundleDescriptor {
  const packageRoot = normalizeRoot(root);
  const manifest = parseJsonObject(raw);
  const components = resolveComponentPaths(packageRoot, buildComponentInventory("pi", manifest));
  const version = manifestVersionEvidence(manifest.version, "bundle");
  return Object.freeze({
    host: "pi",
    coordinates: Object.freeze({ host: "pi", root: packageRoot }),
    name: manifestName(manifest, packageRoot, "package"),
    ...(version === undefined ? {} : { version }),
    components,
    warnings: Object.freeze([]),
    manifestDigest: manifestDigest([{ path: manifestPathFor(packageRoot, "package.json"), content: raw }]),
  });
}

/**
 * Reads one Claude Code plugin manifest. `name` is required. Component paths
 * are relative to the plugin root. The marketplace binding is added by
 * `parseClaudeMarketplace` or `discoverBundlesInSnapshot`, which own the
 * `marketplaceRoot` coordinate.
 */
export function parseClaudePluginManifest(raw: string, root: string): BundleDescriptor {
  const pluginRoot = normalizeRoot(root);
  const manifest = parseJsonObject(raw);
  const name = requiredName(manifest, "plugin.json");
  const components = resolveComponentPaths(pluginRoot, buildComponentInventory("claude", manifest));
  const version = manifestVersionEvidence(manifest.version, "bundle");
  return Object.freeze({
    host: "claude",
    coordinates: Object.freeze({ host: "claude", marketplaceRoot: pluginRoot, pluginName: name }),
    name,
    ...(version === undefined ? {} : { version }),
    components,
    warnings: Object.freeze([]),
    manifestDigest: manifestDigest([{ path: manifestPathFor(pluginRoot, ".claude-plugin/plugin.json"), content: raw }]),
  });
}

/**
 * Reads one marketplace and returns a descriptor per `plugins` entry. The
 * `readPluginManifest` resolver supplies the raw plugin.json for an in-repo
 * entry, because the entry version overrides the plugin manifest version and
 * the plugin manifest owns the component inventory (agents, hooks, and so on).
 * A `command` source and any source outside the repository yield a descriptor
 * with a warning rather than a throw.
 */
export function parseClaudeMarketplace(
  raw: string,
  root: string,
  readPluginManifest: (pluginRoot: string) => string | undefined,
): readonly BundleDescriptor[] {
  const marketplaceRoot = normalizeRoot(root);
  const marketplace = parseJsonObject(raw);
  const entries = marketplace.plugins;
  if (!Array.isArray(entries)) {
    throw new PackageManifestError("marketplace.json must define a plugins array");
  }
  const metadataPluginRoot = isRecord(marketplace.metadata) && typeof marketplace.metadata.pluginRoot === "string"
    ? normalizeComponentPath(marketplace.metadata.pluginRoot)
    : "";

  const descriptors: BundleDescriptor[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      throw new PackageManifestError(`marketplace.json plugins[${index}] must be an object`);
    }
    descriptors.push(buildMarketplaceDescriptor(
      entry,
      `plugins[${index}]`,
      marketplaceRoot,
      metadataPluginRoot,
      raw,
      readPluginManifest,
    ));
  }
  return Object.freeze(descriptors);
}

/**
 * The typed component inventory for one host manifest. Pi reads the `pi` key or
 * the conventional directories; Claude reads the plugin component keys plus the
 * default `skills/` directory. Kinds are normalized once; ownership is derived
 * from the kind, and the deferred kinds are referenced only from
 * `DEFERRED_COMPONENT_KINDS`, never re-listed here.
 */
export function buildComponentInventory(host: PackageHost, manifest: unknown): readonly PackageComponent[] {
  if (!isRecord(manifest)) {
    return Object.freeze([]);
  }
  return host === "pi" ? buildPiInventory(manifest) : buildClaudeInventory(manifest);
}

/**
 * One pass over the snapshot. Indexes `package.json` at the scope root and
 * `.claude-plugin/*.json` anywhere under it. A dual-format repository yields
 * one Pi descriptor and one Claude descriptor over the same skills directory.
 * Refusals are warnings, not throws: a scoped Source URL refuses a Pi package,
 * a Pi manifest below the scope root is not a bundle, and a Claude plugin with
 * no in-repo marketplace binding is reported but not installable.
 */
export function discoverBundlesInSnapshot(
  files: readonly SourceContentFile[],
  scope: { readonly directory?: string } = {},
): readonly BundleDescriptor[] {
  const scopeRoot = normalizeRoot(scope.directory ?? "");
  const descriptors: BundleDescriptor[] = [];

  const rootPackage = files.find((file) => file.path === manifestPathFor(scopeRoot, "package.json"));
  if (rootPackage !== undefined) {
    const descriptor = parsePiPackageManifest(rootPackage.content, scopeRoot);
    if (hasPiManifestKey(rootPackage.content)) {
      descriptors.push(scope.directory === undefined
        ? descriptor
        : withWarnings(descriptor, ["Pi packages are not installable from a scoped Source; register the repository root"]));
    } else {
      const pruned = pruneConventionalComponents(descriptor, files);
      if (pruned.components.length > 0) {
        descriptors.push(scope.directory === undefined
          ? pruned
          : withWarnings(pruned, ["Pi packages are not installable from a scoped Source; register the repository root"]));
      }
    }
  }

  const pluginManifests = new Map<string, string>();
  for (const file of files) {
    const pluginRoot = pluginRootForPath(file.path);
    if (pluginRoot !== undefined) {
      pluginManifests.set(pluginRoot, file.content);
    }
  }

  const boundPluginRoots = new Set<string>();
  const readPluginManifest = (pluginRoot: string): string | undefined => {
    boundPluginRoots.add(pluginRoot);
    return pluginManifests.get(pluginRoot);
  };

  for (const file of files) {
    const marketplaceRoot = marketplaceRootForPath(file.path);
    if (marketplaceRoot === undefined) {
      continue;
    }
    descriptors.push(...parseClaudeMarketplace(file.content, marketplaceRoot, readPluginManifest));
  }

  for (const [pluginRoot, raw] of pluginManifests) {
    if (boundPluginRoots.has(pluginRoot)) {
      continue;
    }
    const descriptor = parseClaudePluginManifest(raw, pluginRoot);
    descriptors.push(withWarnings(descriptor, [
      `Claude plugin ${JSON.stringify(pluginRoot)} has no in-repo marketplace binding; it is not installable`,
    ]));
  }

  return Object.freeze(descriptors.map((descriptor) => populateSkillNames(descriptor, files)));
}

/**
 * The owned-skill matcher shared by the later guard module. A skill path is
 * owned by a bundle when it sits under a `skill-category` component path, and
 * is not claimed when it crosses an excluded lifecycle segment, matching the
 * filter skill discovery applies.
 */
export function bundleOwnedSkillMatcher(
  descriptors: readonly BundleDescriptor[],
): (skillPath: string) => BundleDescriptor | undefined {
  const owners = descriptors.map((descriptor) => ({
    descriptor,
    roots: descriptor.components
      .filter((component) => component.kind === "skills" && component.ownership === "skill-category")
      .flatMap((component) => component.paths),
  }));

  return (skillPath: string): BundleDescriptor | undefined => {
    const normalized = normalizeSkillDirectory(skillPath);
    if (normalized === undefined || hasLifecycleSegment(normalized)) {
      return undefined;
    }
    for (const owner of owners) {
      if (owner.roots.some((root) => matchesBundlePath(root, normalized))) {
        return owner.descriptor;
      }
    }
    return undefined;
  };
}

const COMPONENT_KIND_ORDER: readonly PackageComponentKind[] = [
  "skills", "extensions", "prompts", "themes", "agents", "commands", "hooks",
  "mcp-servers", "lsp-servers", "output-styles", "workflows", "monitors",
];

const COMPONENT_EFFECTS: Readonly<Record<PackageComponentKind, PackageComponentEffect>> = Object.freeze({
  skills: "instruction",
  extensions: "executable",
  prompts: "data",
  themes: "data",
  agents: "instruction",
  commands: "instruction",
  hooks: "executable",
  "mcp-servers": "executable",
  "lsp-servers": "executable",
  "output-styles": "data",
  workflows: "instruction",
  monitors: "executable",
});

const PI_COMPONENT_KEYS = Object.freeze([
  ["skills", "skills"],
  ["extensions", "extensions"],
  ["prompts", "prompts"],
  ["themes", "themes"],
] as const satisfies readonly (readonly [string, PackageComponentKind])[]);

const CLAUDE_COMPONENT_KEYS = Object.freeze([
  ["agents", "agents"],
  ["commands", "commands"],
  ["hooks", "hooks"],
  ["mcpServers", "mcp-servers"],
  ["lspServers", "lsp-servers"],
  ["outputStyles", "output-styles"],
  ["workflows", "workflows"],
] as const satisfies readonly (readonly [string, PackageComponentKind])[]);

function componentOwnership(kind: PackageComponentKind): PackageComponentOwnership {
  return kind === "skills" ? "skill-category" : "host-only";
}

function makeComponent(kind: PackageComponentKind, paths: readonly string[]): PackageComponent {
  return Object.freeze({
    kind,
    ownership: componentOwnership(kind),
    effect: COMPONENT_EFFECTS[kind],
    paths: Object.freeze(dedupeStrings(paths)),
  });
}

function buildPiInventory(manifest: Record<string, unknown>): readonly PackageComponent[] {
  const pi = isRecord(manifest.pi) ? manifest.pi : undefined;
  if (pi !== undefined) {
    const components: PackageComponent[] = [];
    for (const [key, kind] of PI_COMPONENT_KEYS) {
      const paths = stringPaths(pi[key]);
      if (paths.length > 0) {
        components.push(makeComponent(kind, paths));
      }
    }
    return Object.freeze(sortComponents(components));
  }
  // Conventional fallback: the four slots, pruned against the snapshot by discovery.
  return Object.freeze(sortComponents(PI_COMPONENT_KEYS.map(([key, kind]) => makeComponent(kind, [key]))));
}

function buildClaudeInventory(manifest: Record<string, unknown>): readonly PackageComponent[] {
  const components: PackageComponent[] = [];
  // Skills add to the default skills/ directory rather than replacing it.
  components.push(makeComponent("skills", ["skills", ...stringPaths(manifest.skills)]));
  for (const [key, kind] of CLAUDE_COMPONENT_KEYS) {
    const paths = stringPaths(manifest[key]);
    if (paths.length > 0) {
      components.push(makeComponent(kind, paths));
    }
  }
  if (isRecord(manifest.experimental)) {
    const themes = stringPaths(manifest.experimental.themes);
    if (themes.length > 0) {
      components.push(makeComponent("themes", themes));
    }
    const monitors = stringPaths(manifest.experimental.monitors);
    if (monitors.length > 0) {
      components.push(makeComponent("monitors", monitors));
    }
  }
  return Object.freeze(sortComponents(components));
}

interface MarketplaceDescriptorParts {
  readonly entry: Record<string, unknown>;
  readonly entryName: string;
  readonly marketplaceRoot: string;
  readonly marketplaceRaw: string;
  readonly warnings: readonly string[];
}

function buildMarketplaceDescriptor(
  entry: Record<string, unknown>,
  label: string,
  marketplaceRoot: string,
  metadataPluginRoot: string,
  marketplaceRaw: string,
  readPluginManifest: (pluginRoot: string) => string | undefined,
): BundleDescriptor {
  const entryName = requiredName(entry, label);
  if (entry.source === undefined) {
    throw new PackageManifestError(`marketplace.json ${label}.source is required`);
  }
  const resolution = resolveMarketplaceSource(entry.source, marketplaceRoot, metadataPluginRoot);

  if (resolution.kind === "command") {
    return marketplaceOnlyDescriptor({
      entry, entryName, marketplaceRoot, marketplaceRaw,
      warnings: [`marketplace entry ${JSON.stringify(entryName)} uses a command source, which Agent Depot will not run; it is not installable`],
    });
  }
  if (resolution.kind === "external") {
    return marketplaceOnlyDescriptor({
      entry, entryName, marketplaceRoot, marketplaceRaw,
      warnings: [`marketplace entry ${JSON.stringify(entryName)} points outside the registered repository; it is not installable`],
    });
  }

  const pluginRoot = resolution.pluginRoot;
  const pluginRaw = readPluginManifest(pluginRoot);
  if (pluginRaw === undefined) {
    return marketplaceOnlyDescriptor({
      entry, entryName, marketplaceRoot, marketplaceRaw,
      warnings: [`marketplace entry ${JSON.stringify(entryName)} has no plugin manifest at ${manifestPathFor(pluginRoot, ".claude-plugin/plugin.json")}`],
    });
  }

  const plugin = parseClaudePluginManifest(pluginRaw, pluginRoot);
  const warnings: string[] = [];
  if (plugin.name !== entryName) {
    warnings.push(`marketplace entry name ${JSON.stringify(entryName)} differs from plugin manifest name ${JSON.stringify(plugin.name)}`);
  }
  const entryVersion = manifestVersionEvidence(entry.version, "marketplace-entry");
  const version = entryVersion ?? plugin.version;
  return Object.freeze({
    host: "claude",
    coordinates: Object.freeze({ host: "claude", marketplaceRoot, pluginName: entryName }),
    name: entryName,
    ...(version === undefined ? {} : { version }),
    components: plugin.components,
    warnings: Object.freeze(warnings),
    manifestDigest: manifestDigest([
      { path: manifestPathFor(marketplaceRoot, ".claude-plugin/marketplace.json"), content: marketplaceRaw },
      { path: manifestPathFor(pluginRoot, ".claude-plugin/plugin.json"), content: pluginRaw },
    ]),
  });
}

function marketplaceOnlyDescriptor(parts: MarketplaceDescriptorParts): BundleDescriptor {
  const version = manifestVersionEvidence(parts.entry.version, "marketplace-entry");
  return Object.freeze({
    host: "claude",
    coordinates: Object.freeze({ host: "claude", marketplaceRoot: parts.marketplaceRoot, pluginName: parts.entryName }),
    name: parts.entryName,
    ...(version === undefined ? {} : { version }),
    components: resolveComponentPaths(parts.marketplaceRoot, buildComponentInventory("claude", parts.entry)),
    warnings: Object.freeze(parts.warnings),
    manifestDigest: manifestDigest([{ path: manifestPathFor(parts.marketplaceRoot, ".claude-plugin/marketplace.json"), content: parts.marketplaceRaw }]),
  });
}

type MarketplaceSourceResolution =
  | { readonly kind: "in-repo"; readonly pluginRoot: string }
  | { readonly kind: "external" }
  | { readonly kind: "command" };

function resolveMarketplaceSource(
  source: unknown,
  marketplaceRoot: string,
  metadataPluginRoot: string,
): MarketplaceSourceResolution {
  if (typeof source === "string") {
    if (source.startsWith("./")) {
      const relative = normalizeComponentPath(source);
      return relative === "" ? { kind: "external" } : { kind: "in-repo", pluginRoot: resolveBundlePath(marketplaceRoot, relative) };
    }
    const bare = normalizeComponentPath(source);
    if (bare !== "" && metadataPluginRoot !== "") {
      return { kind: "in-repo", pluginRoot: resolveBundlePath(marketplaceRoot, `${metadataPluginRoot}/${bare}`) };
    }
    return { kind: "external" };
  }
  if (isRecord(source)) {
    return Object.hasOwn(source, "command") ? { kind: "command" } : { kind: "external" };
  }
  return { kind: "external" };
}

function resolveComponentPaths(root: string, components: readonly PackageComponent[]): readonly PackageComponent[] {
  const base = normalizeRoot(root);
  if (base === "") {
    return components;
  }
  return Object.freeze(components.map((component) => Object.freeze({
    ...component,
    paths: Object.freeze(component.paths.map((entry) => `${base}/${entry}`)),
  })));
}

function pruneConventionalComponents(descriptor: BundleDescriptor, files: readonly SourceContentFile[]): BundleDescriptor {
  const conventionalKinds = new Set(["skills", "extensions", "prompts", "themes"]);
  const components = descriptor.components.filter((component) => {
    if (!conventionalKinds.has(component.kind)) {
      return true;
    }
    return component.paths.some((directory) =>
      files.some((file) => file.path === directory || file.path.startsWith(`${directory}/`)),
    );
  });
  return Object.freeze({ ...descriptor, components: Object.freeze(components) });
}

function populateSkillNames(descriptor: BundleDescriptor, files: readonly SourceContentFile[]): BundleDescriptor {
  const components = descriptor.components.map((component) => {
    if (component.kind !== "skills") {
      return component;
    }
    const names = new Set<string>();
    for (const file of files) {
      if (path.posix.basename(file.path) !== "SKILL.md") {
        continue;
      }
      const directory = path.posix.dirname(file.path);
      if (directory === "." || hasLifecycleSegment(directory)) {
        continue;
      }
      if (component.paths.some((spec) => matchesBundlePath(spec, directory))) {
        names.add(path.posix.basename(directory));
      }
    }
    if (names.size === 0) {
      return component;
    }
    return Object.freeze({ ...component, skillNames: Object.freeze([...names].sort()) });
  });
  return Object.freeze({ ...descriptor, components: Object.freeze(components) });
}

function matchesBundlePath(spec: string, skillDirectory: string): boolean {
  if (skillDirectory === spec) {
    return true;
  }
  if (spec.includes("*")) {
    return globToRegExp(spec).test(skillDirectory) || globToRegExp(`${spec}/*`).test(skillDirectory);
  }
  return skillDirectory.startsWith(`${spec}/`);
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      out += pattern[index + 1] === "*" ? ".*" : "[^/]*";
      if (pattern[index + 1] === "*") {
        index += 1;
      }
    } else if ("\\^$.|+()[]{}-".includes(character)) {
      out += `\\${character}`;
    } else {
      out += character;
    }
  }
  return new RegExp(`${out}$`, "u");
}

function manifestDigest(files: readonly { readonly path: string; readonly content: string }[]): string {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  hash.update("agent-depot-package-manifest-v1\0", "utf8");
  for (const file of sorted) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const contentBytes = Buffer.from(file.content, "utf8");
    hash.update(`${pathBytes.byteLength}:`, "utf8");
    hash.update(pathBytes);
    hash.update(`${contentBytes.byteLength}:`, "utf8");
    hash.update(contentBytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function manifestVersionEvidence(value: unknown, declaredBy: "bundle" | "marketplace-entry"): PackageVersionEvidence | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return Object.freeze({ kind: "manifest-version", version: value, declaredBy });
}

function manifestName(manifest: Record<string, unknown>, root: string, fallback: string): string {
  if (typeof manifest.name === "string" && manifest.name.trim() !== "") {
    return manifest.name.trim();
  }
  const base = path.posix.basename(root);
  return base === "" || base === "." ? fallback : base;
}

function requiredName(manifest: Record<string, unknown>, label: string): string {
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new PackageManifestError(`${label} must define a non-empty name`);
  }
  return manifest.name.trim();
}

function stringPaths(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const normalized = normalizeComponentPath(value);
    return normalized === "" ? Object.freeze([]) : Object.freeze([normalized]);
  }
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "" || entry.startsWith("!")) {
      continue;
    }
    const normalized = normalizeComponentPath(entry);
    if (normalized !== "") {
      paths.push(normalized);
    }
  }
  return Object.freeze(paths);
}

function normalizeComponentPath(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed === "" || trimmed.includes("\\")) {
    return "";
  }
  const normalized = path.posix.normalize(trimmed.replace(/^\.\//u, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return "";
  }
  return normalized;
}

function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  if (trimmed === "" || trimmed === ".") {
    return "";
  }
  const normalized = path.posix.normalize(trimmed.replace(/^\.\//u, ""));
  return normalized === "." ? "" : normalized.replace(/\/+$/u, "");
}

function manifestPathFor(root: string, filename: string): string {
  const base = normalizeRoot(root);
  return base === "" ? filename : `${base}/${filename}`;
}

function resolveBundlePath(root: string, componentPath: string): string {
  const base = normalizeRoot(root);
  return base === "" ? componentPath : `${base}/${componentPath}`;
}

function marketplaceRootForPath(filePath: string): string | undefined {
  const marker = ".claude-plugin/marketplace.json";
  if (filePath === marker) {
    return "";
  }
  const suffix = `/${marker}`;
  return filePath.endsWith(suffix) ? normalizeRoot(filePath.slice(0, -suffix.length)) : undefined;
}

function pluginRootForPath(filePath: string): string | undefined {
  const marker = ".claude-plugin/plugin.json";
  if (filePath === marker) {
    return "";
  }
  const suffix = `/${marker}`;
  return filePath.endsWith(suffix) ? normalizeRoot(filePath.slice(0, -suffix.length)) : undefined;
}

function normalizeSkillDirectory(candidate: string): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\\")) {
    return undefined;
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

function hasLifecycleSegment(skillDirectory: string): boolean {
  return skillDirectory.split("/").some((segment) => (EXCLUDED_LIFECYCLE_SEGMENTS as readonly string[]).includes(segment));
}

function hasPiManifestKey(raw: string): boolean {
  const manifest = parseJsonObject(raw);
  return isRecord(manifest.pi);
}

function withWarnings(descriptor: BundleDescriptor, warnings: readonly string[]): BundleDescriptor {
  return Object.freeze({ ...descriptor, warnings: Object.freeze([...descriptor.warnings, ...warnings]) });
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function sortComponents(components: readonly PackageComponent[]): readonly PackageComponent[] {
  const order = new Map(COMPONENT_KIND_ORDER.map((kind, index) => [kind, index]));
  return Object.freeze([...components].sort((left, right) =>
    (order.get(left.kind) ?? 0) - (order.get(right.kind) ?? 0),
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the JSON could not be parsed";
    throw new PackageManifestError(`manifest is not valid JSON (${reason})`);
  }
  if (!isRecord(value)) {
    throw new PackageManifestError("manifest must be a JSON object");
  }
  return value;
}
