import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { canonicalizeGitSourceUrl, validateGitRef } from "./git-source.js";

export const PROJECT_MANIFEST_VERSION = 1 as const;
export const PROJECT_MANIFEST_FILENAME = "agent-depot.json" as const;
/** The package release that supplies the built-in Source, when it can be read. */
export const AGENT_DEPOT_PACKAGE_VERSION = readAgentDepotPackageVersion();

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

/** For the built-in Source, latest follows the installed Agent Depot package. */
export interface LatestVersionPolicy {
  readonly policy: "latest";
}

export interface FixedVersionPolicy {
  readonly policy: "fixed";
  readonly version: string;
}

export type VersionPolicy = LatestVersionPolicy | FixedVersionPolicy;

/** A portable command represented as an executable and argument vector. */
export interface SourceInstallationMethod {
  readonly kind: "command";
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
}

/** User-provided fallback methods shared by project and user-global selections. */
export interface ProjectSkillMethods {
  readonly install?: SourceInstallationMethod;
  readonly update?: SourceInstallationMethod;
}

export type ResolvedVersionEvidence =
  | {
      readonly kind: "builtin-package";
      /** The Agent Depot package version that supplied the built-in tree. */
      readonly version: string;
    }
  | {
      readonly kind: "git-commit";
      /** The immutable commit resolved for the Git Source and ref. */
      readonly commit: string;
    };

/** A content-only identity for the installed Skill tree. */
export interface SkillInstallationBaseline {
  readonly algorithm: "sha256";
  readonly digest: string;
}

export interface ProjectSkillInstallation {
  /** POSIX path relative to the project root where the Skill is actually installed. */
  readonly path: string;
  /** True when the existing project tree was adopted without writing it. */
  readonly adopted: boolean;
  /** Resolved Source evidence captured at installation time; absent means unknown. */
  readonly resolvedVersion?: ResolvedVersionEvidence;
  /** Content baseline captured at installation time; absent means unknown. */
  readonly baseline?: SkillInstallationBaseline;
}

export interface ProjectSkillSelection {
  readonly source: ProjectSource;
  /** POSIX path to the selected skill directory within the Source. */
  readonly path: string;
  readonly version: VersionPolicy;
  readonly hosts: readonly ProjectHost[];
  /** Optional user-provided fallback commands for installation and future updates. */
  readonly methods?: ProjectSkillMethods;
  /** Actual project installation location, when this selection has been installed. */
  readonly installation?: ProjectSkillInstallation;
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

function normalizeRelativePath(value: unknown, label: string, manifestPath: string, boundary = "its Source"): string {
  const candidate = nonEmptyString(value, label, manifestPath);
  if (candidate.includes("\\")) {
    throw new ProjectManifestError(manifestPath, `${label} must use POSIX separators`);
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new ProjectManifestError(manifestPath, `${label} must stay within ${boundary}`);
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

interface InstallationMethodParserOptions {
  readonly label?: string;
  readonly error?: (message: string) => Error;
}

/**
 * Validates the shared command shape used by Source metadata and user configuration.
 * The caller supplies the error type so Source adapters and manifests can report
 * failures in their own domain without maintaining divergent safety rules.
 */
export function parsePortableInstallationMethod(
  value: unknown,
  options: InstallationMethodParserOptions = {},
): SourceInstallationMethod {
  const label = options.label ?? "installation method";
  const fail = (reason: string): never => {
    throw (options.error ?? ((message: string) => new Error(message)))(`${label} ${reason}`);
  };

  if (!isRecord(value)) {
    return fail("must be an object");
  }
  assertKeysForMethod(value, ["kind", "argv", "cwd"], label, options);
  if (value.kind !== "command" || !Array.isArray(value.argv) || value.argv.length === 0 ||
    value.argv.some((part) => typeof part !== "string" || part.length === 0 || /[\u0000-\u001f\u007f]/u.test(part))) {
    return fail("must define a non-empty argv array without control characters");
  }

  const argv = value.argv as string[];
  const executable = argv[0];
  if (!/^[A-Za-z0-9._+-]+$/u.test(executable) || isShellInterpreter(executable) || /\.(?:bat|cmd|com|exe|ps1)$/iu.test(executable)) {
    return fail("executable is not a safe portable no-shell command name");
  }
  if (argv.some((part) => /[;&|<>$`]/u.test(part))) {
    return fail("contains shell syntax");
  }
  const credentialFlag = /^(?:--?)(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|auth[-_]?token|client[-_]?secret|credential|oauth[-_]?token|pass(?:word|wd)?|private[-_]?key|refresh[-_]?token|secret|secret[-_]?key|token)(?:$|[=:])/iu;
  for (const [index, part] of argv.entries()) {
    if (containsObviousCredential(part)) {
      return fail("contains an obvious credential or environment assignment");
    }
    if (credentialFlag.test(part) || (index > 0 && credentialFlag.test(argv[index - 1] ?? ""))) {
      return fail("contains a credential-style argument");
    }
  }

  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value.cwd) || path.posix.isAbsolute(value.cwd) ||
    /^[A-Za-z]:/u.test(value.cwd) || value.cwd === ".." || value.cwd.startsWith("../") ||
    value.cwd.includes("\\") || containsObviousCredential(value.cwd))) {
    return fail("cwd is unsafe");
  }
  return Object.freeze({
    kind: "command",
    argv: Object.freeze([...argv] as [string, ...string[]]),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  });
}

function assertKeysForMethod(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  options: InstallationMethodParserOptions,
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) {
    throw (options.error ?? ((message: string) => new Error(message)))(
      `${label} contains unsupported field ${JSON.stringify(unsupported)}`,
    );
  }
}

function isShellInterpreter(executable: string): boolean {
  const normalized = executable.toLowerCase();
  return new Set([
    "sh", "sh.exe", "bash", "bash.exe", "zsh", "zsh.exe", "fish", "fish.exe",
    "dash", "ksh", "ksh93", "csh", "tcsh", "ash",
    "cmd", "cmd.exe", "command.com", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  ]).has(normalized);
}

function containsObviousCredential(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.+$/u.test(value) ||
    /(?:^|[=:])[A-Za-z_][A-Za-z0-9_]*=.+/u.test(value) ||
    /(?:^|[/\\])(?:access[-_]?key|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|pass(?:word|wd)?|private[-_]?key|refresh[-_]?token|secret|token)[=_-][^/\\\s]+/iu.test(value) ||
    /^(?:[A-Za-z][A-Za-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]+@/u.test(value) ||
    /^(?:authorization|proxy-authorization)\s*:/iu.test(value) ||
    /^(?:basic|bearer)\s+\S+/iu.test(value) ||
    /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/u.test(value);
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
    let ref: string | undefined;
    if (value.ref !== undefined) {
      ref = nonEmptyString(value.ref, `${label}.ref`, manifestPath);
      try {
        validateGitRef(ref);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "the ref is unsafe";
        throw new ProjectManifestError(manifestPath, `${label}.ref is invalid (${reason})`);
      }
    }
    const source: ExternalUrlProjectSource = ref === undefined
      ? { kind: "external", url }
      : { kind: "external", url, ref };
    return Object.freeze(source);
  }

  if (typeof value.path === "string") {
    throw new ProjectManifestError(
      manifestPath,
      `${label}.path is not supported in portable manifests; use an external Git URL so the Source identity is resolvable on another machine`,
    );
  }

  throw new ProjectManifestError(manifestPath, `${label} must define exactly one external url or path`);
}

function parseVersionPolicy(value: unknown, source: ProjectSource, manifestPath: string, index: number): VersionPolicy {
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
    if (source.kind === "builtin") {
      if (AGENT_DEPOT_PACKAGE_VERSION === undefined) {
        throw new ProjectManifestError(
          manifestPath,
          `${label}.version cannot be fixed because the current Agent Depot package version is unavailable`,
        );
      }
      if (version !== AGENT_DEPOT_PACKAGE_VERSION) {
        throw new ProjectManifestError(
          manifestPath,
          `${label}.version must equal the current Agent Depot package version ${JSON.stringify(AGENT_DEPOT_PACKAGE_VERSION)}; ${JSON.stringify(version)} cannot be reproduced by this package`,
        );
      }
    } else if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(version)) {
      throw new ProjectManifestError(manifestPath, `${label}.version must be a 40- or 64-character commit ID for a fixed policy`);
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

function parseResolvedVersion(value: unknown, source: ProjectSource, label: string, manifestPath: string): ResolvedVersionEvidence {
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  if (value.kind === "builtin-package") {
    assertKeys(value, ["kind", "version"], label, manifestPath);
    if (source.kind !== "builtin") {
      throw new ProjectManifestError(manifestPath, `${label} is only valid for the built-in Source`);
    }
    return Object.freeze({
      kind: "builtin-package",
      version: nonEmptyString(value.version, `${label}.version`, manifestPath),
    });
  }
  if (value.kind === "git-commit") {
    assertKeys(value, ["kind", "commit"], label, manifestPath);
    if (source.kind !== "external" || !("url" in source)) {
      throw new ProjectManifestError(manifestPath, `${label} is only valid for a Git Source`);
    }
    const commit = nonEmptyString(value.commit, `${label}.commit`, manifestPath);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
      throw new ProjectManifestError(manifestPath, `${label}.commit must be a 40- or 64-character commit ID`);
    }
    return Object.freeze({ kind: "git-commit", commit });
  }
  throw new ProjectManifestError(manifestPath, `${label}.kind is unsupported`);
}

function parseInstallationBaseline(value: unknown, label: string, manifestPath: string): SkillInstallationBaseline {
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  assertKeys(value, ["algorithm", "digest"], label, manifestPath);
  if (value.algorithm !== "sha256") {
    throw new ProjectManifestError(manifestPath, `${label}.algorithm must be \"sha256\"`);
  }
  const digest = nonEmptyString(value.digest, `${label}.digest`, manifestPath);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new ProjectManifestError(manifestPath, `${label}.digest must be a 64-character lowercase SHA-256 digest`);
  }
  return Object.freeze({ algorithm: "sha256", digest });
}

function parseInstallation(value: unknown, source: ProjectSource, manifestPath: string, index: number): ProjectSkillInstallation {
  const label = `skills[${index}].installation`;
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  assertKeys(value, ["path", "adopted", "resolvedVersion", "baseline"], label, manifestPath);
  if (typeof value.adopted !== "boolean") {
    throw new ProjectManifestError(manifestPath, `${label}.adopted must be a boolean`);
  }
  const pathValue = normalizeRelativePath(value.path, `${label}.path`, manifestPath, "the project");
  if (pathValue === ".") {
    throw new ProjectManifestError(manifestPath, `${label}.path must identify a location within the project`);
  }
  const resolvedVersion = value.resolvedVersion === undefined
    ? undefined
    : parseResolvedVersion(value.resolvedVersion, source, `${label}.resolvedVersion`, manifestPath);
  const baseline = value.baseline === undefined
    ? undefined
    : parseInstallationBaseline(value.baseline, `${label}.baseline`, manifestPath);
  return Object.freeze({
    path: pathValue,
    adopted: value.adopted,
    ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
    ...(baseline === undefined ? {} : { baseline }),
  });
}

function parseMethods(value: unknown, manifestPath: string, index: number): ProjectSkillMethods {
  const label = `skills[${index}].methods`;
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  assertKeys(value, ["install", "update"], label, manifestPath);
  const parse = (method: unknown, name: "install" | "update"): SourceInstallationMethod | undefined => {
    if (method === undefined) {
      return undefined;
    }
    return parsePortableInstallationMethod(method, {
      label: `${label}.${name}`,
      error: (message) => new ProjectManifestError(manifestPath, message),
    });
  };
  const install = parse(value.install, "install");
  const update = parse(value.update, "update");
  return Object.freeze({
    ...(install === undefined ? {} : { install }),
    ...(update === undefined ? {} : { update }),
  });
}

function parseSelection(value: unknown, manifestPath: string, index: number): ProjectSkillSelection {
  const label = `skills[${index}]`;
  if (!isRecord(value)) {
    throw new ProjectManifestError(manifestPath, `${label} must be an object`);
  }
  assertKeys(value, ["source", "path", "version", "hosts", "installation", "methods"], label, manifestPath);
  const source = parseSource(value.source, manifestPath, index);
  const version = parseVersionPolicy(value.version, source, manifestPath, index);
  if (version.policy === "latest" && source.kind === "external" && "url" in source && source.ref !== undefined && isCommitId(source.ref)) {
    throw new ProjectManifestError(
      manifestPath,
      `${label}.version cannot use latest with an immutable commit Source ref; use a fixed policy`,
    );
  }
  if (version.policy === "fixed" && source.kind === "external" && "url" in source && source.ref !== version.version) {
    throw new ProjectManifestError(
      manifestPath,
      `${label}.version must match source.ref so a fixed policy pins the selected commit`,
    );
  }
  const installation = value.installation === undefined
    ? undefined
    : parseInstallation(value.installation, source, manifestPath, index);
  const methods = value.methods === undefined
    ? undefined
    : parseMethods(value.methods, manifestPath, index);
  if (installation?.resolvedVersion?.kind === "git-commit" && source.kind === "external" &&
    "url" in source && source.ref !== undefined && isCommitId(source.ref) && installation.resolvedVersion.commit !== source.ref) {
    throw new ProjectManifestError(
      manifestPath,
      `${label}.installation.resolvedVersion.commit must match the immutable Source ref`,
    );
  }
  if (installation?.resolvedVersion !== undefined && version.policy === "fixed") {
    const resolved = installation.resolvedVersion.kind === "git-commit"
      ? installation.resolvedVersion.commit
      : installation.resolvedVersion.version;
    if (resolved !== version.version) {
      throw new ProjectManifestError(
        manifestPath,
        `${label}.installation.resolvedVersion must match the fixed version policy`,
      );
    }
  }
  return Object.freeze({
    source,
    path: normalizeSkillPath(value.path, `${label}.path`, manifestPath),
    version,
    hosts: parseHosts(value.hosts, manifestPath, index),
    ...(installation === undefined ? {} : { installation }),
    ...(methods === undefined ? {} : { methods }),
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

  let committed = false;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, manifestPath);
    } catch (error) {
      // Windows may refuse an atomic replacement of an existing regular file.
      // Never unlink a symlink or non-file as a fallback: that could redirect
      // the replacement outside the project.
      if (process.platform !== "win32" || !isWindowsRenameConflict(error)) {
        throw error;
      }
      const existing = await lstat(manifestPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new ProjectManifestError(manifestPath, "refusing unsafe Windows manifest replacement target");
      }
      await unlink(manifestPath);
      await rename(temporaryPath, manifestPath);
    }
    committed = true;
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFile(error) && !committed) {
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

function readAgentDepotPackageVersion(): string | undefined {
  try {
    const packageJson = createRequire(import.meta.url)("../../package.json") as unknown;
    if (!isRecord(packageJson) || typeof packageJson.version !== "string" || packageJson.version.length === 0) {
      return undefined;
    }
    return packageJson.version;
  } catch {
    return undefined;
  }
}

function isCommitId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isWindowsRenameConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EEXIST" || error.code === "EPERM" || error.code === "ENOTEMPTY");
}
