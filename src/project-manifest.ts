import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalizeGitSourceUrl } from "./git-source.js";

export const PROJECT_MANIFEST_VERSION = 1 as const;
export const PROJECT_MANIFEST_FILENAME = "agent-depot.json" as const;

export const PROJECT_HOSTS = Object.freeze(["pi", "claude", "codex", "opencode"] as const);
export type ProjectHost = (typeof PROJECT_HOSTS)[number];

export interface BuiltInProjectSource {
  readonly kind: "builtin";
  readonly id: "builtin:agent-depot";
}

export interface ExternalUrlProjectSource {
  readonly kind: "external";
  readonly url: string;
  readonly ref?: string;
}

export interface ExternalPathProjectSource {
  readonly kind: "external";
  readonly path: string;
  readonly ref?: string;
}

/** A manifest source is self-contained and does not refer to global Source state. */
export type ProjectSource = BuiltInProjectSource | ExternalUrlProjectSource | ExternalPathProjectSource;

export interface LatestVersionPolicy {
  readonly policy: "latest";
}

export interface FixedVersionPolicy {
  readonly policy: "fixed";
  readonly version: string;
}

export type VersionPolicy = LatestVersionPolicy | FixedVersionPolicy;

export interface ProjectSkillSelection {
  readonly source: ProjectSource;
  /** POSIX path to the selected skill directory within the Source. */
  readonly path: string;
  readonly version: VersionPolicy;
  readonly hosts: readonly ProjectHost[];
}

export interface ProjectManifest {
  readonly version: typeof PROJECT_MANIFEST_VERSION;
  readonly skills: readonly ProjectSkillSelection[];
}

const EMPTY_PROJECT_MANIFEST: ProjectManifest = Object.freeze({
  version: PROJECT_MANIFEST_VERSION,
  skills: Object.freeze([]),
});

export class ProjectManifestError extends Error {
  readonly manifestPath: string;

  constructor(manifestPath: string, reason: string) {
    super(`Invalid project manifest ${JSON.stringify(manifestPath)}: ${reason}`);
    this.name = "ProjectManifestError";
    this.manifestPath = manifestPath;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, manifestPath: string): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unsupported) {
    throw new ProjectManifestError(manifestPath, `${label} contains unsupported field ${JSON.stringify(unsupported)}`);
  }
}

function nonEmptyString(value: unknown, label: string, manifestPath: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ProjectManifestError(manifestPath, `${label} must be a non-empty string without surrounding whitespace`);
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProjectManifestError(manifestPath, `${label} contains unsafe whitespace or control characters`);
  }
  return value;
}

function normalizeRelativePath(value: unknown, label: string, manifestPath: string): string {
  const candidate = nonEmptyString(value, label, manifestPath);
  if (candidate.includes("\\")) {
    throw new ProjectManifestError(manifestPath, `${label} must use POSIX separators`);
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new ProjectManifestError(manifestPath, `${label} must stay within its Source`);
  }
  return normalized;
}

function normalizeSkillPath(value: unknown, label: string, manifestPath: string): string {
  const normalized = normalizeRelativePath(value, label, manifestPath);
  if (normalized === ".") {
    throw new ProjectManifestError(manifestPath, `${label} must identify a skill below its Source root`);
  }
  return normalized;
}

function parseSource(value: unknown, manifestPath: string, index: number): ProjectSource {
  const label = `skills[${index}].source`;
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  if (value.kind === "builtin") {
    assertKeys(value, ["kind", "id"], label, manifestPath);
    if (value.id !== "builtin:agent-depot") {
      throw new ProjectManifestError(manifestPath, `${label}.id must be \"builtin:agent-depot\"`);
    }
    return Object.freeze({ kind: "builtin", id: "builtin:agent-depot" });
  }

  if (value.kind !== "external") {
    throw new ProjectManifestError(manifestPath, `${label}.kind must be \"builtin\" or \"external\"`);
  }
  if (typeof value.url === "string") {
    assertKeys(value, ["kind", "url", "ref"], label, manifestPath);
    let url: string;
    try {
      url = canonicalizeGitSourceUrl(value.url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the URL is invalid";
      throw new ProjectManifestError(manifestPath, `${label}.url is invalid (${reason})`);
    }
    const source: ExternalUrlProjectSource = value.ref === undefined
      ? { kind: "external", url }
      : { kind: "external", url, ref: nonEmptyString(value.ref, `${label}.ref`, manifestPath) };
    return Object.freeze(source);
  }

  if (typeof value.path === "string") {
    assertKeys(value, ["kind", "path", "ref"], label, manifestPath);
    const source: ExternalPathProjectSource = value.ref === undefined
      ? {
        kind: "external",
        path: normalizeRelativePath(value.path, `${label}.path`, manifestPath),
      }
      : {
        kind: "external",
        path: normalizeRelativePath(value.path, `${label}.path`, manifestPath),
        ref: nonEmptyString(value.ref, `${label}.ref`, manifestPath),
      };
    return Object.freeze(source);
  }

  throw new ProjectManifestError(manifestPath, `${label} must define exactly one external url or path`);
}

function parseVersionPolicy(value: unknown, manifestPath: string, index: number): VersionPolicy {
  const label = `skills[${index}].version`;
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  if (value.policy === "latest") {
    assertKeys(value, ["policy"], label, manifestPath);
    return Object.freeze({ policy: "latest" });
  }
  if (value.policy === "fixed") {
    assertKeys(value, ["policy", "version"], label, manifestPath);
    const version = nonEmptyString(value.version, `${label}.version`, manifestPath);
    if (version === "latest") {
      throw new ProjectManifestError(manifestPath, `${label}.version must not be \"latest\" for a fixed policy`);
    }
    return Object.freeze({ policy: "fixed", version });
  }
  throw new ProjectManifestError(manifestPath, `${label}.policy must be \"fixed\" or \"latest\"`);
}

function parseHosts(value: unknown, manifestPath: string, index: number): readonly ProjectHost[] {
  const label = `skills[${index}].hosts`;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectManifestError(manifestPath, `${label} must be a non-empty array`);
  }
  const hosts: ProjectHost[] = [];
  const seen = new Set<string>();
  for (const [hostIndex, host] of value.entries()) {
    if (typeof host !== "string" || !PROJECT_HOSTS.includes(host as ProjectHost)) {
      throw new ProjectManifestError(manifestPath, `${label}[${hostIndex}] is not a supported Host`);
    }
    if (seen.has(host)) {
      throw new ProjectManifestError(manifestPath, `${label} contains duplicate Host ${JSON.stringify(host)}`);
    }
    seen.add(host);
    hosts.push(host as ProjectHost);
  }
  return Object.freeze(hosts);
}

function parseSelection(value: unknown, manifestPath: string, index: number): ProjectSkillSelection {
  const label = `skills[${index}]`;
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  assertKeys(value, ["source", "path", "version", "hosts"], label, manifestPath);
  return Object.freeze({
    source: parseSource(value.source, manifestPath, index),
    path: normalizeSkillPath(value.path, `${label}.path`, manifestPath),
    version: parseVersionPolicy(value.version, manifestPath, index),
    hosts: parseHosts(value.hosts, manifestPath, index),
  });
}

/** Validates and normalizes an in-memory project manifest without global Source lookup. */
export function parseProjectManifest(value: unknown, manifestPath: string = PROJECT_MANIFEST_FILENAME): ProjectManifest {
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, "the root value must be an object");
  }
  assertKeys(value, ["version", "skills"], "the root", manifestPath);
  if (value.version !== PROJECT_MANIFEST_VERSION) {
    throw new ProjectManifestError(manifestPath, "the manifest version is unsupported");
  }
  if (!Array.isArray(value.skills)) {
    throw new ProjectManifestError(manifestPath, "skills must be an array");
  }

  const skills = value.skills.map((selection, index) => parseSelection(selection, manifestPath, index));
  const identities = new Set<string>();
  for (const [index, skill] of skills.entries()) {
    const identity = JSON.stringify([skill.source, skill.path]);
    if (identities.has(identity)) {
      throw new ProjectManifestError(manifestPath, `skills[${index}] duplicates an earlier Source and path selection`);
    }
    identities.add(identity);
  }
  return Object.freeze({ version: PROJECT_MANIFEST_VERSION, skills: Object.freeze(skills) });
}

export function defaultProjectManifestPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, PROJECT_MANIFEST_FILENAME);
}

export async function readProjectManifest(manifestPath: string = defaultProjectManifestPath()): Promise<ProjectManifest> {
  let contents: string;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return EMPTY_PROJECT_MANIFEST;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the JSON could not be parsed";
    throw new ProjectManifestError(manifestPath, `malformed JSON (${reason})`);
  }
  return parseProjectManifest(value, manifestPath);
}

export async function writeProjectManifest(manifestPath: string, manifest: ProjectManifest): Promise<void> {
  const normalized = parseProjectManifest(manifest, manifestPath);
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, manifestPath);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFile(error)) {
        throw error;
      }
    });
  }
}

export class ProjectManifestStore {
  readonly path: string;

  constructor(manifestPath: string = defaultProjectManifestPath()) {
    this.path = manifestPath;
  }

  load(): Promise<ProjectManifest> {
    return readProjectManifest(this.path);
  }

  save(manifest: ProjectManifest): Promise<void> {
    return writeProjectManifest(this.path, manifest);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
