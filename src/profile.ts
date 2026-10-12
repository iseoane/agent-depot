import path from "node:path";
import { parseAppRecipe, type AppRecipe } from "./app-recipes.js";
import { canonicalizeGitSourceUrl } from "./git-source.js";
import type { PackageOperations } from "./package-flow.js";
import { selectionKey, type PackageCoordinates, type PackageSelection } from "./package-model.js";
import { containsCredentialArgument, parseProjectManifest, ProjectManifestError, type ProjectSkillSelection } from "./project-manifest.js";

export const PROFILE_FORMAT_V1 = "agent-depot-profile/v1" as const;
export const PROFILE_FORMAT_V2 = "agent-depot-profile/v2" as const;
export const PROFILE_FORMAT = PROFILE_FORMAT_V1;
export interface ProfileSource {
  readonly url: string;
  readonly included: boolean;
}

/** The Package flow surface a portable Profile reads on export and replays on import. */
export type ProfilePackageOperations = Pick<PackageOperations, "list" | "approve" | "planLifecycle" | "executeLifecycle" | "inspect">;

export type ProfileReplica =
  | { readonly kind: "skill"; readonly source: ProjectSkillSelection["source"]; readonly path: string }
  | { readonly kind: "app"; readonly name: string; readonly platform?: AppRecipe["platform"] }
  | { readonly kind: "package"; readonly selection: PackageSelection };

export interface Profile {
  readonly format: typeof PROFILE_FORMAT_V1 | typeof PROFILE_FORMAT_V2;
  readonly agentDepotVersion: string;
  readonly sources: readonly ProfileSource[];
  readonly skills: readonly Omit<ProjectSkillSelection, "installation">[];
  readonly apps: readonly AppRecipe[];
  /** Additive since v1. A profile written before Packages existed omits the key and parses as an empty list. */
  readonly packages: readonly PackageSelection[];
  /** Identity-only intent for resources proven installed on the exporting machine. */
  readonly replicas: readonly ProfileReplica[];
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile: expected an object");
  const format = (value as Record<string, unknown>).format;
  if (format !== PROFILE_FORMAT_V1 && format !== PROFILE_FORMAT_V2) throw new Error("profile.format: unsupported profile version");
  const root = object(value, ["format", "agentDepotVersion", "sources", "skills", "apps", "packages", "replicas"], "profile");
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
  const replicas = root.replicas === undefined
    ? []
    : list(root.replicas, "replicas").map((value, index) => parseProfileReplica(value, `replicas[${index}]`));
  if (format === PROFILE_FORMAT_V2 && root.replicas === undefined) throw new Error("replicas: required for profile v2");
  if (format === PROFILE_FORMAT_V1 && replicas.length > 0) throw new Error("replicas: non-empty replica intent requires profile v2");
  rejectDuplicates(sources, source => source.url, "sources");
  rejectDuplicates(packages, selectionKey, "packages");
  rejectDuplicates(replicas, replicaIdentity, "replicas");
  replicas.forEach((replica, index) => {
    const exists = replica.kind === "skill"
      ? parsedSkills.some(skill => skillIdentity(skill) === JSON.stringify([replica.source, replica.path]))
      : replica.kind === "app"
        ? apps.some(app => app.name === replica.name && app.platform === replica.platform)
        : packages.some(selection => selectionKey(selection) === selectionKey(replica.selection));
    if (!exists) throw new Error(`replicas[${index}]: does not reference a profile resource`);
  });
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
  replicas.sort((a, b) => compare(replicaIdentity(a), replicaIdentity(b)));
  return { format, agentDepotVersion: root.agentDepotVersion, sources, skills: sortedSkills, apps, packages, replicas };
}

/**
 * An empty Package block is omitted, so an export with no Packages stays readable
 * by an Agent Depot version that predates the block.
 */
function skillIdentity(skill: Pick<ProjectSkillSelection, "source" | "path">): string {
  return JSON.stringify([skill.source, skill.path]);
}

function replicaIdentity(replica: ProfileReplica): string {
  switch (replica.kind) {
    case "skill": return JSON.stringify([replica.kind, replica.source, replica.path]);
    case "app": return JSON.stringify([replica.kind, replica.name, replica.platform ?? null]);
    case "package": return JSON.stringify([replica.kind, selectionKey(replica.selection)]);
  }
}

function parseProfileReplica(value: unknown, field: string): ProfileReplica {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: expected an object`);
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "skill") {
    const record = object(value, ["kind", "source", "path"], field);
    const [skill] = parseProjectManifest({ version: 1, skills: [
      { source: record.source, path: record.path, version: { policy: "latest" }, hosts: ["pi"] },
    ] }, "profile").skills;
    return { kind, source: skill!.source, path: skill!.path };
  }
  if (kind === "app") {
    const record = object(value, ["kind", "name", "platform"], field);
    if (typeof record.name !== "string" || record.name.length === 0) throw new Error(`${field}.name: expected a non-empty string`);
    const platform = record.platform;
    if (platform !== undefined && platform !== "linux" && platform !== "windows" && platform !== "darwin") {
      throw new Error(`${field}.platform: unsupported platform`);
    }
    return { kind, name: record.name, ...(platform === undefined ? {} : { platform }) };
  }
  if (kind === "package") {
    const record = object(value, ["kind", "selection"], field);
    return { kind, selection: parseProfilePackage(record.selection, `${field}.selection`) };
  }
  throw new Error(`${field}.kind: expected "skill", "app" or "package"`);
}

export function serializeProfile(profile: Profile): string {
  const format = profile.replicas.length ? PROFILE_FORMAT_V2 : PROFILE_FORMAT_V1;
  const parsed = parseProfile({ ...profile, format });
  const { packages, replicas, ...rest } = parsed;
  const output = { ...rest, format,
    ...(packages.length ? { packages } : {}),
    ...(replicas.length ? { replicas } : {}) };
  return `${JSON.stringify(output, null, 2)}\n`;
}
