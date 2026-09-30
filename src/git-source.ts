import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runProcess, type ProcessRunResult } from "./process-runner.js";

export interface GitSource {
  readonly id: string;
  readonly kind: "git";
  readonly url: string;
  /** Optional immutable project selection ref (for example refs/tags/v1.2.3). */
  readonly ref?: string;
}

export interface GitSourceAccess {
  refresh(source: GitSource): Promise<void>;
}

export interface GitCommandRunnerOptions {
  readonly cwd?: string;
}

/** Runs one executable with an argument vector and never invokes a shell. */
export interface GitCommandRunner {
  run(command: string, args: readonly string[], options?: GitCommandRunnerOptions): Promise<void>;
}

export interface GitSnapshotCommandRunnerOptions {
  readonly maxOutputBytes?: number;
}

export interface GitSnapshotCommandRunner {
  run(command: string, args: readonly string[], options?: GitSnapshotCommandRunnerOptions): Promise<string>;
  runBinary(command: string, args: readonly string[], options?: GitSnapshotCommandRunnerOptions): Promise<Uint8Array>;
}

export interface GitSourceSnapshotFile {
  readonly path: string;
  readonly content: string;
}

export interface GitSourceSkillTreeFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

/** The immutable commit selected by a Git Source ref or its current HEAD. */
export type GitSourceResolvedVersion = string;

export interface GitSourceSkillTreeSnapshot {
  readonly resolvedVersion: GitSourceResolvedVersion;
  readonly files: readonly GitSourceSkillTreeFile[];
}

export const SKILL_TREE_LIMITS = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathBytes: 4096,
  maxDepth: 32,
  maxListingBytes: 16 * 1024 * 1024,
});

const EXCLUDED_LIFECYCLE_SEGMENTS = new Set([
  "in-progress",
  "beta",
  "deprecated",
  "retired",
]);

export class GitSourceAccessError extends Error {
  constructor(source: GitSource, reason: string) {
    super(`Unable to refresh Git Source ${JSON.stringify(source.id)} from ${JSON.stringify(source.url)}: ${reason}`);
    this.name = "GitSourceAccessError";
  }
}

function gitFailureDetail(result: ProcessRunResult): string {
  return result.stderr.trim()
    || (result.signal ? `terminated by ${result.signal}` : `exited with code ${result.code ?? "unknown"}`);
}

class NodeGitCommandRunner implements GitCommandRunner {
  async run(command: string, args: readonly string[], options: GitCommandRunnerOptions = {}): Promise<void> {
    const result = await runProcess(command, args, options.cwd === undefined ? {} : { cwd: options.cwd });
    if (result.code !== 0) {
      throw new Error(`git command failed: ${gitFailureDetail(result)}`);
    }
  }
}

class NodeGitSnapshotCommandRunner implements GitSnapshotCommandRunner {
  async run(command: string, args: readonly string[], options: GitSnapshotCommandRunnerOptions = {}): Promise<string> {
    return Buffer.from(await this.runBinary(command, args, options)).toString("utf8");
  }

  async runBinary(command: string, args: readonly string[], options: GitSnapshotCommandRunnerOptions = {}): Promise<Uint8Array> {
    const result = await runProcess(command, args, {
      captureStdout: true,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });
    if (result.outputTooLarge) {
      throw new Error("git command output exceeds the safe size limit");
    }
    if (result.code !== 0) {
      throw new Error(`git command failed: ${gitFailureDetail(result)}`);
    }
    return result.stdout;
  }
}

export interface GitSourceAccessOptions {
  readonly cachePath?: string;
  readonly runner?: GitCommandRunner;
}

const SOURCE_LOCK_TIMEOUT_MS = 30_000;
const SOURCE_LOCK_RETRY_MS = 10;

/**
 * Clones each Source into a local mirror and refreshes it from the registered
 * URL. Mirrors are intentionally not checked out: discovery owns later reads.
 */
export class GitSourceAccessAdapter implements GitSourceAccess {
  readonly cachePath: string;
  private readonly runner: GitCommandRunner;

  constructor(options: GitSourceAccessOptions = {}) {
    this.cachePath = options.cachePath ?? defaultGitSourceCachePath();
    this.runner = options.runner ?? new NodeGitCommandRunner();
  }

  async refresh(source: GitSource): Promise<void> {
    const expectedId = sourceIdForUrl(source.url);
    if (source.kind !== "git" || source.id !== expectedId) {
      throw new GitSourceAccessError(source, "the Source identity does not match its registered URL");
    }

    const destination = cachePathForValidatedSource(this.cachePath, source);
    try {
      await assertNoSymlinkPath(this.cachePath);
      await mkdir(this.cachePath, { recursive: true });
      await assertNoSymlinkPath(this.cachePath);

      const release = await acquireSourceLock(`${destination}.lock`);
      try {
        await this.refreshLocked(source, destination);
      } finally {
        await release();
      }
    } catch (error) {
      if (error instanceof GitSourceAccessError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : "the Git command failed";
      throw new GitSourceAccessError(source, reason);
    }
  }

  private async refreshLocked(source: GitSource, destination: string): Promise<void> {
    const existing = await pathType(destination);
    if (existing === "symlink") {
      throw new Error("the Source cache path is a symbolic link");
    }
    if (existing === "file") {
      throw new Error("the Source cache path is not a directory");
    }
    if (existing === "directory") {
      await assertNoSymlinkPath(destination);
      // The explicit mirror refspec synchronizes branches, tags, and other
      // refs from the registered URL while --prune removes deleted refs.
      await this.runner.run("git", [
        "-C",
        destination,
        "fetch",
        "--prune",
        "--force",
        source.url,
        "+refs/*:refs/*",
      ]);
      return;
    }

    const temporaryDestination = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.runner.run("git", ["clone", "--mirror", source.url, temporaryDestination]);
      await assertNoSymlinkPath(temporaryDestination);
      if ((await pathType(temporaryDestination)) !== "directory") {
        throw new Error("Git clone did not create a directory mirror");
      }
      await rename(temporaryDestination, destination);
    } finally {
      await rm(temporaryDestination, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Reads the current HEAD from an existing bare mirror without refreshing it. */
export class GitSourceSnapshotAccess {
  private readonly cachePath: string;
  private readonly runner: GitSnapshotCommandRunner;

  constructor(options: { readonly cachePath?: string; readonly runner?: GitSnapshotCommandRunner } = {}) {
    this.cachePath = options.cachePath ?? defaultGitSourceCachePath();
    this.runner = options.runner ?? new NodeGitSnapshotCommandRunner();
  }

  async readSkillTree(source: GitSource, skillPath: string): Promise<readonly GitSourceSkillTreeFile[]> {
    return (await this.readSkillTreeSnapshot(source, skillPath)).files;
  }

  /** Reads Skill bytes and the commit they came from as one immutable snapshot. */
  async readSkillTreeSnapshot(source: GitSource, skillPath: string): Promise<GitSourceSkillTreeSnapshot> {
    const relativeSkillPath = validateSkillDirectoryPath(skillPath);
    const destination = cachePathForSource(this.cachePath, source);
    if ((await pathType(destination)) !== "directory") {
      throw new Error(`Git Source mirror is not available: ${destination}`);
    }
    await assertNoSymlinkPath(destination);

    const commit = await this.readResolvedCommit(source);
    const tree = await this.runner.run("git", [
      "--git-dir",
      destination,
      "ls-tree",
      "-r",
      "-z",
      commit,
      "--",
      relativeSkillPath,
    ], { maxOutputBytes: SKILL_TREE_LIMITS.maxListingBytes });
    if (Buffer.byteLength(tree, "utf8") > SKILL_TREE_LIMITS.maxListingBytes) {
      throw new Error("Selected Skill tree listing exceeds the safe size limit");
    }

    const prefix = `${relativeSkillPath}/`;
    const files: GitSourceSkillTreeFile[] = [];
    let totalBytes = 0;
    let hasSkillManifest = false;
    for (const record of tree.split("\0")) {
      if (!record) {
        continue;
      }
      if (files.length >= SKILL_TREE_LIMITS.maxFiles) {
        throw new Error("Selected Skill tree contains too many files");
      }
      const separator = record.indexOf("\t");
      if (separator < 0) {
        throw new Error("Git Source returned a malformed Skill tree entry");
      }
      const metadata = record.slice(0, separator).split(" ");
      const mode = metadata[0];
      const objectType = metadata[1];
      const objectId = metadata[2];
      const relativePath = record.slice(separator + 1);
      if (!relativePath.startsWith(prefix) || !isSafeSourcePath(relativePath) || relativePath === prefix.slice(0, -1)) {
        throw new Error("Git Source returned a Skill tree path outside the selected directory");
      }
      if (mode === "120000" || objectType !== "blob" || (mode !== "100644" && mode !== "100755")) {
        throw new Error(`Selected Skill tree contains an unsupported Git entry: ${relativePath}`);
      }
      if (!objectId || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
        throw new Error("Git Source returned an unsafe object reference");
      }

      const content = await this.runner.runBinary("git", ["--git-dir", destination, "cat-file", "blob", objectId], {
        maxOutputBytes: SKILL_TREE_LIMITS.maxFileBytes,
      });
      const byteLength = content.byteLength;
      if (byteLength > SKILL_TREE_LIMITS.maxFileBytes) {
        throw new Error(`Selected Skill file exceeds the safe size limit: ${relativePath}`);
      }
      totalBytes += byteLength;
      if (totalBytes > SKILL_TREE_LIMITS.maxTotalBytes) {
        throw new Error("Selected Skill tree exceeds the safe total size limit");
      }
      if (relativePath === `${relativeSkillPath}/SKILL.md`) {
        hasSkillManifest = true;
      }
      files.push({ path: relativePath, content, executable: mode === "100755" });
    }

    if (!hasSkillManifest) {
      throw new Error(`Selected Skill directory does not contain ${relativeSkillPath}/SKILL.md`);
    }
    return Object.freeze({
      resolvedVersion: commit,
      files: Object.freeze(files),
    });
  }

  /** Resolves the selected ref to an immutable commit without refreshing the mirror. */
  async readResolvedCommit(source: GitSource): Promise<GitSourceResolvedVersion> {
    const destination = cachePathForSource(this.cachePath, source);
    if ((await pathType(destination)) !== "directory") {
      throw new Error(`Git Source mirror is not available: ${destination}`);
    }
    await assertNoSymlinkPath(destination);

    const revision = source.ref === undefined ? "HEAD" : validateGitRef(source.ref);
    const commit = (await this.runner.run("git", [
      "--git-dir",
      destination,
      "rev-parse",
      "--verify",
      `${revision}^{commit}`,
    ], { maxOutputBytes: 128 })).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
      throw new Error(`Git Source mirror has no safe HEAD snapshot: ${source.id}`);
    }
    return commit;
  }

  async readSnapshot(source: GitSource): Promise<readonly GitSourceSnapshotFile[]> {
    const destination = cachePathForSource(this.cachePath, source);
    if ((await pathType(destination)) !== "directory") {
      throw new Error(`Git Source mirror is not available: ${destination}`);
    }
    await assertNoSymlinkPath(destination);

    const commit = await this.readResolvedCommit(source);
    const tree = await this.runner.run("git", ["--git-dir", destination, "ls-tree", "-r", "-z", commit]);
    const files: GitSourceSnapshotFile[] = [];
    for (const record of tree.split("\0")) {
      if (!record) {
        continue;
      }
      const separator = record.indexOf("\t");
      if (separator < 0) {
        continue;
      }
      const metadata = record.slice(0, separator).split(" ");
      const relativePath = record.slice(separator + 1);
      if (
        metadata[0] === "120000"
        || metadata[1] !== "blob"
        || !relativePath
        || path.posix.basename(relativePath) !== "SKILL.md"
        || relativePath.split("/").slice(0, -1).some((segment) => EXCLUDED_LIFECYCLE_SEGMENTS.has(segment))
      ) {
        continue;
      }
      files.push({
        path: relativePath,
        content: await this.runner.run("git", ["--git-dir", destination, "show", `${commit}:${relativePath}`]),
      });
    }
    return Object.freeze(files);
  }
}

export function defaultGitSourceCachePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA || environment.APPDATA;
    return pathApi.join(localAppData || pathApi.join(homeDirectory, "AppData", "Local"), "Agent Depot", "git-sources");
  }

  const cacheHome = environment.XDG_CACHE_HOME;
  return pathApi.join(
    cacheHome && pathApi.isAbsolute(cacheHome) ? cacheHome : pathApi.join(homeDirectory, ".cache"),
    "agent-depot",
    "git-sources",
  );
}

export function cachePathForSource(cachePath: string, source: GitSource): string {
  const expectedId = sourceIdForUrl(source.url);
  if (source.kind !== "git" || source.id !== expectedId) {
    throw new GitSourceAccessError(source, "the Source identity does not match its registered URL");
  }
  return cachePathForValidatedSource(cachePath, source);
}

function cachePathForValidatedSource(cachePath: string, source: GitSource): string {
  return path.join(cachePath, source.id.slice("git:".length));
}

type PathKind = "directory" | "file" | "missing" | "symlink";

async function pathType(candidate: string): Promise<PathKind> {
  try {
    const information = await lstat(candidate);
    if (information.isSymbolicLink()) {
      return "symlink";
    }
    return information.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (isMissing(error)) {
      return "missing";
    }
    throw error;
  }
}

async function assertNoSymlinkPath(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const root = path.parse(absolute).root;
  let current = root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`cache path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
  }
}

async function acquireSourceLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + SOURCE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rmdir(lockPath);
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if ((await pathType(lockPath)) === "symlink") {
        throw new Error("the Source cache lock is a symbolic link");
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the Source cache lock directory is busy: ${lockPath}; another refresh might be active. Wait for it to finish before retrying`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, SOURCE_LOCK_RETRY_MS));
    }
  }
}

export function validateGitRef(candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.trim() !== candidate ||
    Array.from(candidate).some((character) => (character.codePointAt(0) ?? 0) <= 0x20) ||
    /[~^:?*[\\]/u.test(candidate) || candidate.includes("..") || candidate.includes("@{")) {
    throw new Error("Git Source ref contains unsafe characters");
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment.endsWith(".") || segment.startsWith("."))) {
    throw new Error("Git Source ref contains an unsafe path segment");
  }
  return candidate;
}

export function validateSkillDirectoryPath(candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Selected Skill path must be a non-empty relative POSIX path");
  }
  if (Buffer.byteLength(candidate, "utf8") > SKILL_TREE_LIMITS.maxPathBytes
    || candidate.includes("\\")
    || Array.from(candidate).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
    || candidate.startsWith("/")
    || candidate.endsWith("/")) {
    throw new Error("Selected Skill path contains unsafe characters");
  }

  const segments = candidate.split("/");
  if (segments.length > SKILL_TREE_LIMITS.maxDepth || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Selected Skill path must not contain traversal segments");
  }
  return candidate;
}

function isSafeSourcePath(candidate: string): boolean {
  try {
    validateSkillDirectoryPath(candidate);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

const GIT_PROTOCOLS = new Set(["git:", "http:", "https:", "ssh:"]);

export function canonicalizeGitSourceUrl(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.trim() !== input) {
    throw new Error("Git Source URL must be a non-empty URL without surrounding whitespace");
  }
  if (/\s/u.test(input) || input.includes("\\") || Array.from(input).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) {
    throw new Error("Git Source URL contains unsafe characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Git Source URL is invalid");
  }

  if (!GIT_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported Git Source protocol: ${parsed.protocol}`);
  }
  if (!parsed.hostname || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Git Source URL contains unsupported or unsafe components");
  }
  if (parsed.username && parsed.username !== "git") {
    throw new Error("Git Source URL credentials are not allowed");
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username) {
    throw new Error("HTTP Git Source URLs cannot contain credentials");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  if (parsed.pathname === "/" || parsed.pathname.length < 2) {
    throw new Error("Git Source URL must identify a repository path");
  }

  return parsed.toString();
}

export function sourceIdForUrl(url: string): string {
  const canonicalUrl = canonicalizeGitSourceUrl(url);
  const digest = createHash("sha256").update(canonicalUrl, "utf8").digest("hex").slice(0, 24);
  return `git:${digest}`;
}
