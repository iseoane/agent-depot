import path from "node:path";
import { parseAppRecipe, type AppRecipe } from "./app-recipes.js";
import { canonicalizeGitSourceUrl } from "./git-source.js";
import { containsCredentialArgument, parseProjectManifest, ProjectManifestError, type ProjectSkillSelection } from "./project-manifest.js";

export const PROFILE_FORMAT = "agent-depot-profile/v1" as const;
export interface ProfileSource {
  readonly url: string;
  readonly included: boolean;
}
export interface Profile {
  readonly format: typeof PROFILE_FORMAT;
  readonly agentDepotVersion: string;
  readonly sources: readonly ProfileSource[];
  readonly skills: readonly Omit<ProjectSkillSelection, "installation">[];
  readonly apps: readonly AppRecipe[];
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

/** Portable profile parsing shares the manifest and recipe safety contracts. */
export function parseProfile(value: unknown): Profile {
  const root = object(value, ["format", "agentDepotVersion", "sources", "skills", "apps"], "profile");
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
  rejectDuplicates(sources, source => source.url, "sources");
  rejectDuplicates(apps, app => JSON.stringify([app.name, app.platform ?? null]), "apps");
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  sources.sort((a, b) => compare(a.url, b.url));
  const sortedSkills = [...parsedSkills].sort((a, b) => compare(JSON.stringify([a.source, a.path]), JSON.stringify([b.source, b.path])));
  apps.sort((a, b) => compare(a.name, b.name) || compare(a.platform ?? "", b.platform ?? ""));
  return { format: PROFILE_FORMAT, agentDepotVersion: root.agentDepotVersion, sources, skills: sortedSkills, apps };
}

export function serializeProfile(profile: Profile): string {
  return `${JSON.stringify(parseProfile(profile), null, 2)}\n`;
}
