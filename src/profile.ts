import path from "node:path";
import { parseAppRecipe, type AppRecipe } from "./app-recipes.js";
import { canonicalizeGitSourceUrl } from "./git-source.js";
import type { PackageOperations } from "./package-flow.js";
import { selectionKey, type PackageCoordinates, type PackageSelection } from "./package-model.js";
import { containsCredentialArgument, parseProjectManifest, ProjectManifestError, type ProjectSkillSelection } from "./project-manifest.js";

export const PROFILE_FORMAT = "agent-depot-profile/v1" as const;
export interface ProfileSource {
  readonly url: string;
  readonly included: boolean;
}

/** The Package flow surface a portable Profile reads on export and replays on import. */
export type ProfilePackageOperations = Pick<PackageOperations, "list" | "approve" | "planLifecycle" | "executeLifecycle">;

export interface Profile {
  readonly format: typeof PROFILE_FORMAT;
  readonly agentDepotVersion: string;
  readonly sources: readonly ProfileSource[];
  readonly skills: readonly Omit<ProjectSkillSelection, "installation">[];
  readonly apps: readonly AppRecipe[];
  /** Additive since v1. A profile written before Packages existed omits the key and parses as an empty list. */
  readonly packages: readonly PackageSelection[];
}

function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: expected an object`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find(key => !keys.includes(key));
  if (extra !== undefined) throw new Error(`${field}.${extra}: unsupported profile field`);
  return record;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field}: expected an array`);
  return value;
}

/** Recipes can contain free text; portable profiles additionally forbid machine paths and credentials. */
function assertPortableText(value: unknown, field: string): void {
  if (typeof value === "string") {
    const commandPath = /(?:\.argv\[\d+\]|\.cwd)$/u.test(field) &&
      (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
    const regexPattern = /\.(?:version|latest)\.pattern$/u.test(field);
    if (commandPath || (!regexPattern && /(?:^|[\s="'(])(?:\/(?!\/)[\w.]|[A-Za-z]:[/\\]|\\\\)/u.test(value))) {
      throw new Error(`${field}: absolute local paths are not portable`);
    }
    if (/[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/iu.test(value)) {
      throw new Error(`${field}: credentials are not portable`);
    }
    for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu)) {
      let url: URL;
      try {
        url = new URL(match[0]);
      } catch {
        throw new Error(`${field}: invalid URL`);
      }
      const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
      if (keys.some(key => /^(?:token|key|apikey|secret|password|passwd|auth|sig|signature|accesstoken|privatetoken)$/u.test(
        key.replace(/[-_]/gu, "").toLowerCase(),
      ))) {
        throw new Error(`${field}: credentials are not portable`);
      }
    }
    // Manual text is not argv: check credentials without forbidding its shell instructions.
    if (containsCredentialArgument(value) || value.split(/\s+/u).some(containsCredentialArgument)) {
      throw new Error(`${field}: credentials are not portable`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableText(item, `${field}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertPortableText(item, `${field}.${key}`);
  }
}

function rejectDuplicates<T>(items: readonly T[], identity: (item: T) => string, field: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = identity(item);
    if (seen.has(key)) throw new Error(`${field}[${index}]: duplicate identity`);
    seen.add(key);
  });
}

/** A Source-relative bundle root in the one canonical form discovery produces. */
function bundleDirectory(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}: expected a string`);
  if (value === "") return value;
  const noncanonical = value.startsWith("/") || value === "." || value.startsWith("./") || value.endsWith("/") ||
    value.includes("//") || value.includes("\\") || value === ".." || value.startsWith("../") ||
    path.posix.normalize(value) !== value;
  if (noncanonical) throw new Error(`${field}: expected a canonical Source-relative directory`);
  return value;
}

/** The single segment a Claude selection names, matching the host's own plugin key. */
function pluginName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field}: expected a plugin name`);
  const unsafe = [...value].some(character => (character.codePointAt(0) ?? 0) <= 0x1f || character.codePointAt(0) === 0x7f);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || /\s/u.test(value) || unsafe) {
    throw new Error(`${field}: expected one plugin name segment`);
  }
  return value;
}

/**
 * A Package declaration carries its Source identity, host coordinates and version
 * policy. The host's own install identity, verified version and receipt stay out,
 * so they cannot travel to another machine.
 */
function parseProfilePackage(value: unknown, field: string): PackageSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: expected an object`);
  const host = (value as Record<string, unknown>).host;
  if (host !== "pi" && host !== "claude") throw new Error(`${field}.host: expected "pi" or "claude"`);
  const record = object(value, host === "pi"
    ? ["source", "version", "host", "root"]
    : ["source", "version", "host", "marketplaceRoot", "pluginName"], field);
  const coordinates: PackageCoordinates = host === "pi"
    ? { host, root: bundleDirectory(record.root, `${field}.root`) }
    : { host, marketplaceRoot: bundleDirectory(record.marketplaceRoot, `${field}.marketplaceRoot`),
      pluginName: pluginName(record.pluginName, `${field}.pluginName`) };
  const at = (root: string, name: string) => root === "" ? name : `${root}/${name}`;
  const manifestPath = coordinates.host === "pi"
    ? at(coordinates.root, "package.json")
    : at(coordinates.marketplaceRoot, ".claude-plugin/marketplace.json");
  try {
    const [parsed] = parseProjectManifest({ version: 1, skills: [
      { source: record.source, path: manifestPath, version: record.version, hosts: [host] },
    ] }, "profile").skills;
    return Object.freeze({ source: parsed!.source, version: parsed!.version, ...coordinates });
  } catch (error) {
    if (!(error instanceof ProjectManifestError)) throw error;
    const rootField = coordinates.host === "pi" ? "root" : "marketplaceRoot";
    const reason = error.reason.replace(/^skills\[0\]\.path/u, `${field}.${rootField}`).replace(/^skills\[0\]\./u, `${field}.`);
    const [path0, ...rest] = reason.split(" ");
    throw new Error(`${path0}: ${rest.join(" ")}`);
  }
}

/** Portable profile parsing shares the manifest and recipe safety contracts. */
export function parseProfile(value: unknown): Profile {
  const root = object(value, ["format", "agentDepotVersion", "sources", "skills", "apps", "packages"], "profile");
  if (root.format !== PROFILE_FORMAT) throw new Error("profile.format: unsupported profile version");
  if (typeof root.agentDepotVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u.test(root.agentDepotVersion)) {
    throw new Error("profile.agentDepotVersion: expected a package version");
  }
  const sources = list(root.sources, "sources").map((value, index) => {
    const field = `sources[${index}]`;
    const source = object(value, ["url", "included"], field);
    if (typeof source.included !== "boolean") throw new Error(`${field}.included: expected a boolean`);
    try {
      return { url: canonicalizeGitSourceUrl(source.url as string), included: source.included };
    } catch (error) {
      throw new Error(`${field}.url: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const skills = list(root.skills, "skills");
  skills.forEach((value, index) => object(value, ["source", "path", "version", "hosts", "methods"], `skills[${index}]`));
  let parsedSkills: readonly ProjectSkillSelection[];
  try {
    parsedSkills = parseProjectManifest({ version: 1, skills }, "profile").skills;
  } catch (error) {
    if (!(error instanceof ProjectManifestError)) throw error;
    const [field, ...reason] = error.reason.split(" ");
    throw new Error(`${field}: ${reason.join(" ")}`);
  }
  parsedSkills.forEach((skill, index) => {
    assertPortableText(skill.path, `skills[${index}].path`);
    assertPortableText(skill.version, `skills[${index}].version`);
    assertPortableText(skill.methods, `skills[${index}].methods`);
  });
  const apps = list(root.apps, "apps").map((value, index) => {
    try {
      const recipe = parseAppRecipe(value);
      assertPortableText(recipe, `apps[${index}]`);
      return recipe;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(reason.startsWith(`apps[${index}]`) ? reason : `apps[${index}].${reason}`);
    }
  });
  const packages = (root.packages === undefined ? [] : list(root.packages, "packages")).map((value, index) => {
    const field = `packages[${index}]`;
    const selection = parseProfilePackage(value, field);
    assertPortableText(selection, field);
    return selection;
  });
  rejectDuplicates(sources, source => source.url, "sources");
  rejectDuplicates(packages, selectionKey, "packages");
  apps.forEach((app, index) => {
    if (apps.slice(0, index).some(previous => previous.name === app.name &&
      (previous.platform === undefined || app.platform === undefined || previous.platform === app.platform))) {
      throw new Error(`apps[${index}]: duplicate applicable App name ${JSON.stringify(app.name)}`);
    }
  });
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  sources.sort((a, b) => compare(a.url, b.url));
  const sortedSkills = [...parsedSkills].sort((a, b) => compare(JSON.stringify([a.source, a.path]), JSON.stringify([b.source, b.path])));
  apps.sort((a, b) => compare(a.name, b.name) || compare(a.platform ?? "", b.platform ?? ""));
  packages.sort((a, b) => compare(selectionKey(a), selectionKey(b)));
  return { format: PROFILE_FORMAT, agentDepotVersion: root.agentDepotVersion, sources, skills: sortedSkills, apps, packages };
}

/**
 * An empty Package block is omitted, so an export with no Packages stays readable
 * by an Agent Depot version that predates the block.
 */
export function serializeProfile(profile: Profile): string {
  const parsed = parseProfile(profile);
  const { packages, ...rest } = parsed;
  return `${JSON.stringify(packages.length === 0 ? rest : parsed, null, 2)}\n`;
}
