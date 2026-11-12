import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { isLockContention } from "./atomic-file.js";
import { assertNoSymlinkPath } from "./path-safety.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import { decodeSnapshotBatch, reuseSourceSnapshot, SOURCE_SNAPSHOT_LIMITS } from "./source-snapshot.js";

export interface GitSource {
  readonly id: string;
  readonly kind: "git";
  readonly url: string;
  /** Optional immutable project selection ref (for example refs/tags/v1.2.3). */
  readonly ref?: string;
}

/** How a refresh runs; a background refresh cannot prompt for credentials and is time-limited. */
export interface GitSourceRefreshOptions {
  readonly background?: boolean;
}

export interface GitSourceAccess {
  refresh(source: GitSource, options?: GitSourceRefreshOptions): Promise<void>;
}

export interface GitCommandRunnerOptions {
  readonly cwd?: string;
  /** Variables added to the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Runs one executable with an argument vector and never invokes a shell. */
export interface GitCommandRunner {
  run(command: string, args: readonly string[], options?: GitCommandRunnerOptions): Promise<void>;
}

export interface GitSnapshotCommandRunnerOptions {
  readonly maxOutputBytes?: number;
  readonly stdin?: Uint8Array;
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
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
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

/**
 * One file a Source snapshot carries: a Skill manifest, or a bundle manifest the
 * Package discovery pass reads. The Pi root `package.json` and the two Claude
 * `.claude-plugin` manifests sit beside the Skill files in the same immutable
 * Source view, so one read feeds both passes.
 */
export function isSourceSnapshotFile(relativePath: string, scopeDirectory?: string): boolean {
  if (path.posix.basename(relativePath) === "SKILL.md") {
    return true;
  }
  const segments = relativePath.split("/");
  if (segments.at(-2) === ".claude-plugin") {
    const name = segments.at(-1);
    return name === "plugin.json" || name === "marketplace.json";
  }
  const root = scopeDirectory === undefined || scopeDirectory === "" ? "package.json" : `${scopeDirectory}/package.json`;
  return relativePath === root;
}

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
    const result = await runProcess(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (result.timedOut) {
      throw new Error(`git command timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`);
    }
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
      ...(options.stdin === undefined ? {} : { stdin: options.stdin, timeoutMs: 30_000, maxStderrBytes: 64 * 1024 }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });
    if (result.outputTooLarge) {
      throw new Error("git command output exceeds the safe size limit");
    }
    if (result.timedOut) throw new Error("git command timed out");
    if (result.code !== 0) {
      throw new Error(`git command failed: ${gitFailureDetail(result)}`);
    }
    return result.stdout;
  }
}

export interface GitSourceAccessOptions {
  readonly cachePath?: string;
  readonly runner?: GitCommandRunner;
  /** Test seam: lets a test interleave another process at the points where lock races can occur. */
  readonly lockHooks?: SourceLockHooks;
}

export interface SourceLockHooks {
  /** Runs after a recoverer judged a lock orphaned and before it acts on that judgment. */
  readonly afterJudging?: () => Promise<void>;
  /** Runs after this process created the lock directory and before it publishes its owner record. */
  readonly afterLockCreated?: () => Promise<void>;
  /** Runs once this process holds the lock and before it first uses it. */
  readonly afterLockAcquired?: () => Promise<void>;
  /** Runs after a recoverer confirmed the orphan while holding the recovery mutex, before it removes the lock. */
  readonly beforeOrphanRemoval?: () => Promise<void>;
  /** Replaces the directory removal, so a test can fail it or interleave a successor before a retry. */
  readonly removeDirectory?: (directory: string) => Promise<void>;
}

const SOURCE_LOCK_TIMEOUT_MS = 30_000;
/** D2 (I0031): nobody is watching a background refresh, so it must neither prompt nor hang. */
const BACKGROUND_REFRESH_OPTIONS: GitCommandRunnerOptions = Object.freeze({
  env: Object.freeze({ GIT_TERMINAL_PROMPT: "0" }),
  timeoutMs: 60_000,
});
const SOURCE_LOCK_RETRY_MS = 10;
const SOURCE_LOCK_OWNER_FILE = "owner.json";
const SOURCE_LOCK_OWNER_MAX_BYTES = 4096;
const SOURCE_RECOVERY_MUTEX_ID_FILE = "id";
const LOCK_REMOVAL_ATTEMPTS = 5;
const LOCK_REMOVAL_RETRY_MS = 50;
/** A recovery takes milliseconds, so a mutex this old was left by a process that died mid-recovery. */
const SOURCE_RECOVERY_MUTEX_MAX_AGE_MS = 60_000;
/** Covers locks from versions without an owner record and an acquisition interrupted before writing it. */
const SOURCE_LOCK_OWNERLESS_MAX_AGE_MS = 10 * 60_000;

/**
 * Clones each Source into a local mirror and refreshes it from the registered
 * URL. Mirrors are intentionally not checked out: discovery owns later reads.
 */
export class GitSourceAccessAdapter implements GitSourceAccess {
  readonly cachePath: string;
  private readonly runner: GitCommandRunner;
  private readonly lockHooks: SourceLockHooks;

  constructor(options: GitSourceAccessOptions = {}) {
    this.lockHooks = options.lockHooks ?? {};
    this.cachePath = options.cachePath ?? defaultGitSourceCachePath();
    this.runner = options.runner ?? new NodeGitCommandRunner();
  }

  async refresh(source: GitSource, options: GitSourceRefreshOptions = {}): Promise<void> {
    const expectedId = sourceIdForUrl(source.url);
    if (source.kind !== "git" || source.id !== expectedId) {
      throw new GitSourceAccessError(source, "the Source identity does not match its registered URL");
    }

    const destination = cachePathForValidatedSource(this.cachePath, source);
    try {
      await assertNoSymlinkPath(this.cachePath, "cache path");
      await mkdir(this.cachePath, { recursive: true });
      await assertNoSymlinkPath(this.cachePath, "cache path");

      const lock = await acquireSourceLock(`${destination}.lock`, this.lockHooks);
      try {
        await this.lockHooks.afterLockAcquired?.();
        await lock.assertHeld();
        await this.refreshLocked(source, destination, options.background ? BACKGROUND_REFRESH_OPTIONS : undefined);
      } finally {
        await lock.release();
      }
    } catch (error) {
      if (error instanceof GitSourceAccessError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : "the Git command failed";
      throw new GitSourceAccessError(source, reason);
    }
  }

  private async refreshLocked(source: GitSource, destination: string, runOptions?: GitCommandRunnerOptions): Promise<void> {
    const existing = await pathType(destination);
    if (existing === "symlink") {
      throw new Error("the Source cache path is a symbolic link");
    }
    if (existing === "file") {
      throw new Error("the Source cache path is not a directory");
    }
    if (existing === "directory") {
      await assertNoSymlinkPath(destination, "cache path");
      // The explicit mirror refspec synchronizes branches, tags, and other
      // refs from the registered URL while --prune removes deleted refs.
      await this.runner.run("git", [
        "-C",
        destination,
        "fetch",
        "--prune",
        "--force",
        gitSourceLocation(source.url).repositoryUrl,
        "+refs/*:refs/*",
      ], runOptions);
      return;
    }

    const temporaryDestination = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.runner.run("git", ["clone", "--mirror", gitSourceLocation(source.url).repositoryUrl, temporaryDestination], runOptions);
      await assertNoSymlinkPath(temporaryDestination, "cache path");
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
interface SkillTreeRecord {
  readonly relativePath: string;
  readonly objectId: string;
  readonly executable: boolean;
}

/** Validates one `git ls-tree -z` record of a selected Skill directory. */
function parseSkillTreeRecord(record: string, relativeSkillPath: string): SkillTreeRecord {
  const separator = record.indexOf("\t");
  if (separator < 0) {
    throw new Error("Git Source returned a malformed Skill tree entry");
  }
  const [mode, objectType, objectId] = record.slice(0, separator).split(" ");
  const relativePath = record.slice(separator + 1);
  if (!relativePath.startsWith(`${relativeSkillPath}/`) || !isSafeSourcePath(relativePath)) {
    throw new Error("Git Source returned a Skill tree path outside the selected directory");
  }
  if (objectType !== "blob" || (mode !== "100644" && mode !== "100755")) {
    throw new Error(`Selected Skill tree contains an unsupported Git entry: ${relativePath}`);
  }
  if (!objectId || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
    throw new Error("Git Source returned an unsafe object reference");
  }
  return { relativePath, objectId, executable: mode === "100755" };
}

const defaultSnapshotRunner = new NodeGitSnapshotCommandRunner();

export class GitSourceSnapshotAccess {
  private readonly cachePath: string;
  private readonly runner: GitSnapshotCommandRunner;

  constructor(options: { readonly cachePath?: string; readonly runner?: GitSnapshotCommandRunner } = {}) {
    this.cachePath = options.cachePath ?? defaultGitSourceCachePath();
    this.runner = options.runner ?? defaultSnapshotRunner;
  }

  private async requireMirror(source: GitSource): Promise<string> {
    const destination = cachePathForSource(this.cachePath, source);
    if ((await pathType(destination)) !== "directory") {
      throw new Error(`Git Source mirror is not available: ${destination}`);
    }
    await assertNoSymlinkPath(destination, "cache path");
    return destination;
  }

  async readSkillTree(source: GitSource, skillPath: string): Promise<readonly GitSourceSkillTreeFile[]> {
    return (await this.readSkillTreeSnapshot(source, skillPath)).files;
  }

  /** Reads Skill bytes and the commit they came from as one immutable snapshot. */
  async readSkillTreeSnapshot(source: GitSource, skillPath: string): Promise<GitSourceSkillTreeSnapshot> {
    const relativeSkillPath = validateSkillDirectoryPath(skillPath);
    const directory = gitSourceLocation(source.url).directory;
    if (directory !== undefined && !relativeSkillPath.startsWith(`${directory}/`) && relativeSkillPath !== directory) {
      throw new Error("Selected Skill path is outside the Git Source directory");
    }
    const destination = await this.requireMirror(source);

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

    const files: GitSourceSkillTreeFile[] = [];
    let totalBytes = 0;
    for (const record of tree.split("\0")) {
      if (!record) {
        continue;
      }
      if (files.length >= SKILL_TREE_LIMITS.maxFiles) {
        throw new Error("Selected Skill tree contains too many files");
      }
      const entry = parseSkillTreeRecord(record, relativeSkillPath);
      const content = await this.runner.runBinary("git", ["--git-dir", destination, "cat-file", "blob", entry.objectId], {
        maxOutputBytes: SKILL_TREE_LIMITS.maxFileBytes,
      });
      if (content.byteLength > SKILL_TREE_LIMITS.maxFileBytes) {
        throw new Error(`Selected Skill file exceeds the safe size limit: ${entry.relativePath}`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > SKILL_TREE_LIMITS.maxTotalBytes) {
        throw new Error("Selected Skill tree exceeds the safe total size limit");
      }
      files.push({ path: entry.relativePath, content, executable: entry.executable });
    }
    const hasSkillManifest = files.some((file) => file.path === `${relativeSkillPath}/SKILL.md`);

    if (!hasSkillManifest) {
      throw new Error(`Selected Skill directory does not contain ${relativeSkillPath}/SKILL.md`);
    }
    return Object.freeze({
      resolvedVersion: commit,
      files: Object.freeze(files),
    });
  }

  /** True only when the cached Source history proves `olderCommit` precedes `newerCommit`. */
  async isAncestor(source: GitSource, olderCommit: string, newerCommit: string): Promise<boolean | undefined> {
    if (![olderCommit, newerCommit].every((commit) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(commit))) {
      return undefined;
    }
    try {
      const destination = await this.requireMirror(source);
      await this.runner.run("git", [
        "--git-dir",
        destination,
        "merge-base",
        "--is-ancestor",
        olderCommit,
        newerCommit,
      ]);
      return true;
    } catch {
      return undefined;
    }
  }

  /** Resolves the selected ref to an immutable commit without refreshing the mirror. */
  async readResolvedCommit(source: GitSource): Promise<GitSourceResolvedVersion> {
    const destination = await this.requireMirror(source);

    const revision = validateGitRef(source.ref ?? gitSourceLocation(source.url).ref ?? "HEAD");
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
    const destination = await this.requireMirror(source);
    // Resolve on every read, even on a cache hit: refs can change outside Agent Depot.
    const commit = await this.readResolvedCommit(source);
    const directory = gitSourceLocation(source.url).directory;
    const key = JSON.stringify([path.resolve(destination), commit, directory]);
    return reuseSourceSnapshot(this.runner, key, async () => {
      const tree = await this.runner.run("git", [
        "--no-replace-objects", "--git-dir", destination, "ls-tree", "-r", "-z", commit,
        ...(directory === undefined ? [] : ["--", directory]),
      ], { maxOutputBytes: SKILL_TREE_LIMITS.maxListingBytes });
      if (tree !== "" && !tree.endsWith("\0")) throw new Error("Truncated Git snapshot listing");
      const entries: { path: string; objectId: string }[] = [];
      for (const record of tree.split("\0")) {
        if (!record) continue;
        const separator = record.indexOf("\t");
        if (separator < 0) throw new Error("Malformed Git snapshot listing");
        const [mode, type, objectId] = record.slice(0, separator).split(" ");
        const relativePath = record.slice(separator + 1);
        if (mode === "120000" || type !== "blob" || !relativePath
          || (directory !== undefined && !relativePath.startsWith(`${directory}/`))
          || !isSourceSnapshotFile(relativePath, directory)
          || relativePath.split("/").slice(0, -1).some(segment => EXCLUDED_LIFECYCLE_SEGMENTS.has(segment))) continue;
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)
          || !["100644", "100755"].includes(mode)) throw new Error("Unsafe Git snapshot entry");
        entries.push({ path: relativePath, objectId });
        if (entries.length > SOURCE_SNAPSHOT_LIMITS.maxFiles) throw new Error("Git snapshot exceeds file count limit");
      }
      if (entries.length === 0) return Object.freeze([]);
      const output = await this.runner.runBinary("git", ["--no-replace-objects", "--git-dir", destination, "cat-file", "--batch"], {
        stdin: Buffer.from(entries.map(entry => `${entry.objectId}\n`).join("")),
        maxOutputBytes: SOURCE_SNAPSHOT_LIMITS.maxTotalBytes + entries.length * 130,
      });
      return decodeSnapshotBatch(output, entries);
    });
  }

  /** File paths at or under `root`, from the same immutable commit as the other reads. */
  async listFiles(source: GitSource, root: string): Promise<readonly string[]> {
    const relativeRoot = root === "" ? "" : validateSkillDirectoryPath(root);
    const destination = await this.requireMirror(source);
    const commit = await this.readResolvedCommit(source);
    const tree = await this.runner.run("git", [
      "--git-dir", destination, "ls-tree", "-r", "-z", commit,
      ...(relativeRoot === "" ? [] : ["--", relativeRoot]),
    ], { maxOutputBytes: SKILL_TREE_LIMITS.maxListingBytes });
    if (Buffer.byteLength(tree, "utf8") > SKILL_TREE_LIMITS.maxListingBytes) {
      throw new Error("Source file listing exceeds the safe size limit");
    }
    const files: string[] = [];
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
        || (relativeRoot !== "" && !relativePath.startsWith(`${relativeRoot}/`))
      ) {
        continue;
      }
      files.push(relativePath);
    }
    return Object.freeze(files);
  }

  /** One file's text at `path`, or undefined when the commit has no such blob. */
  async readFile(source: GitSource, path: string): Promise<string | undefined> {
    const safePath = validateSkillDirectoryPath(path);
    const destination = await this.requireMirror(source);
    const commit = await this.readResolvedCommit(source);
    const tree = await this.runner.run("git", [
      "--git-dir", destination, "ls-tree", "-z", commit, "--", safePath,
    ], { maxOutputBytes: SKILL_TREE_LIMITS.maxListingBytes });
    for (const record of tree.split("\0")) {
      if (!record) {
        continue;
      }
      const separator = record.indexOf("\t");
      if (separator < 0) {
        continue;
      }
      const [mode, objectType, objectId] = record.slice(0, separator).split(" ");
      const relativePath = record.slice(separator + 1);
      if (relativePath !== safePath) {
        continue;
      }
      if (objectType !== "blob" || (mode !== "100644" && mode !== "100755")) {
        return undefined;
      }
      if (!objectId || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
        throw new Error("Git Source returned an unsafe object reference");
      }
      const content = await this.runner.run("git", [
        "--git-dir", destination, "cat-file", "blob", objectId,
      ], { maxOutputBytes: SKILL_TREE_LIMITS.maxFileBytes });
      if (Buffer.byteLength(content, "utf8") > SKILL_TREE_LIMITS.maxFileBytes) {
        throw new Error(`Source file exceeds the safe size limit: ${safePath}`);
      }
      return content;
    }
    return undefined;
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

interface SourceLockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  /** Random per acquisition, so a recovery can tell the lock it judged from a successor's. */
  readonly id: string;
}

/** `none` is only a missing owner file; a record that exists but cannot be trusted must never justify a removal. */
type LockOwnerRecord =
  | { readonly kind: "owner"; readonly owner: SourceLockOwner }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

interface SourceLock {
  /** Throws unless the lock's owner record is still this acquisition's. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

const LOCK_TAKEN_OVER_MESSAGE = "the Source cache lock was taken over by another process; this refresh stopped without touching the cache";

/**
 * Removes `directory` only while `stillOurs` holds, re-checked before every attempt. `rm`'s own retry
 * option would repeat the removal on the same path blindly, and a retry that lands after a successor
 * recreated the directory would delete the successor's lock. Windows reports EBUSY, EPERM or
 * ENOTEMPTY while another process still holds a handle on something inside, so only those are retried.
 * Residual limit: the check and the removal are separate calls (the filesystem has no atomic conditional
 * remove), so a successor that takes the path inside that window, microseconds wide, is still removed;
 * two reclaimers of an aged-out recovery mutex can race the same way.
 */
async function removeWhileOurs(directory: string, stillOurs: () => Promise<boolean>, hooks: SourceLockHooks): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (!(await stillOurs())) {
      return;
    }
    try {
      // rm unlinks links instead of following them, so nothing outside the directory is touched.
      await (hooks.removeDirectory ?? ((target) => rm(target, { recursive: true, force: true })))(directory);
      return;
    } catch (error) {
      const transient = ["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "");
      if (!transient || attempt >= LOCK_REMOVAL_ATTEMPTS) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_REMOVAL_RETRY_MS));
    }
  }
}

async function acquireSourceLock(lockPath: string, hooks: SourceLockHooks): Promise<SourceLock> {
  const deadline = Date.now() + SOURCE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      await hooks.afterLockCreated?.();
      return await publishLockOwner(lockPath, hooks);
    } catch (error) {
      if (!isLockContention(error)) {
        throw error;
      }
      if ((await pathType(lockPath)) === "symlink") {
        throw new Error("the Source cache lock is a symbolic link");
      }
      if (await recoverOrphanedLock(lockPath, hooks)) {
        continue;
      }
      if (Date.now() >= deadline) {
        const record = await readLockOwner(lockPath);
        const holder = record.kind === "owner" ? ` (held by process ${record.owner.pid} on host ${record.owner.hostname})` : "";
        throw new Error(
          `the Source cache lock directory is busy: ${lockPath}${holder}; another refresh might be active. Wait for it to finish before retrying`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, SOURCE_LOCK_RETRY_MS));
    }
  }
}

/**
 * Publishes the owner record without ever replacing one: a holder that stalled and lost its lock
 * would otherwise overwrite its successor's record and let both believe they hold it.
 * A hard link fails with EEXIST when the record exists. Where links are unsupported, an exclusive
 * create gives the same no-overwrite guarantee, but a reader can briefly see a partial record,
 * which it treats as unreadable and so never as a reason to remove the lock.
 */
async function publishLockOwner(lockPath: string, hooks: SourceLockHooks): Promise<SourceLock> {
  const owner: SourceLockOwner = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), id: randomUUID() };
  const ownerPath = path.join(lockPath, SOURCE_LOCK_OWNER_FILE);
  const temporaryPath = `${ownerPath}.${owner.id}.tmp`;
  const contents = JSON.stringify(owner);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporaryPath, ownerPath);
    } catch (error) {
      if (!["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      await writeFile(ownerPath, contents, { encoding: "utf8", flag: "wx" });
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(LOCK_TAKEN_OVER_MESSAGE);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // The directory this call created is gone: the lock was recovered, and a successor may already hold a new one.
      throw new Error(LOCK_TAKEN_OVER_MESSAGE);
    }
    // The lock is deliberately not removed here: it may already be a successor's, and an ownerless lock
    // left by this failure is recovered once it is old enough.
    throw error;
  }
  await unlink(temporaryPath).catch(() => undefined);
  return {
    async assertHeld() {
      const record = await readLockOwner(lockPath);
      if (record.kind !== "owner" || record.owner.id !== owner.id) {
        throw new Error(LOCK_TAKEN_OVER_MESSAGE);
      }
    },
    async release() {
      await removeWhileOurs(lockPath, async () => {
        const record = await readLockOwner(lockPath);
        return record.kind === "owner" && record.owner.id === owner.id;
      }, hooks);
    },
  };
}

/** Reads the owner record without following links. */
async function readLockOwner(lockPath: string): Promise<LockOwnerRecord> {
  const ownerPath = path.join(lockPath, SOURCE_LOCK_OWNER_FILE);
  try {
    const information = await lstat(ownerPath);
    if (!information.isFile() || information.size > SOURCE_LOCK_OWNER_MAX_BYTES) {
      return { kind: "unreadable" };
    }
    const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "unreadable" };
    }
    const { pid, hostname: host, startedAt, id } = parsed as Record<string, unknown>;
    return Number.isInteger(pid) && (pid as number) > 0 && typeof host === "string" && typeof startedAt === "string" && typeof id === "string"
      ? { kind: "owner", owner: { pid: pid as number, hostname: host, startedAt, id } }
      : { kind: "unreadable" };
  } catch (error) {
    return isMissing(error) ? { kind: "none" } : { kind: "unreadable" };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function isOldLock(lockPath: string, maxAgeMs: number): Promise<boolean> {
  try {
    return Date.now() - (await lstat(lockPath)).mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

/** The orphan a recoverer judged: a dead owner on this host (by id) or an old lock with no owner record. */
async function judgeOrphan(lockPath: string): Promise<LockOwnerRecord | undefined> {
  const record = await readLockOwner(lockPath);
  if (record.kind === "owner") {
    return record.owner.hostname === hostname() && !isProcessAlive(record.owner.pid) ? record : undefined;
  }
  return record.kind === "none" && await isOldLock(lockPath, SOURCE_LOCK_OWNERLESS_MAX_AGE_MS) ? record : undefined;
}

/**
 * Removes a lock whose holder is provably gone. Recoverers serialize on a short-lived `.recovering`
 * mutex and re-judge the lock in place while holding it, so a judgment made before another process
 * recovered and re-took the lock can never remove (or move) that live lock: nothing but a recoverer
 * removes a lock whose owner is dead, and acquirers cannot replace a lock that still exists.
 * Returns true when the caller should retry the acquisition at once.
 */
async function recoverOrphanedLock(lockPath: string, hooks: SourceLockHooks): Promise<boolean> {
  const judged = await judgeOrphan(lockPath);
  if (judged === undefined) {
    return false;
  }
  await hooks.afterJudging?.();

  const mutexPath = `${lockPath}.recovering`;
  try {
    await mkdir(mutexPath);
  } catch (error) {
    if (!isLockContention(error)) {
      throw error;
    }
    // A recoverer that died holding the mutex would otherwise block recovery for good.
    if (await isOldLock(mutexPath, SOURCE_RECOVERY_MUTEX_MAX_AGE_MS)) {
      await removeWhileOurs(mutexPath, () => isOldLock(mutexPath, SOURCE_RECOVERY_MUTEX_MAX_AGE_MS), hooks);
      return true;
    }
    return false;
  }

  const mutexId = randomUUID();
  const mutexIdPath = path.join(mutexPath, SOURCE_RECOVERY_MUTEX_ID_FILE);
  const ownsMutex = async (): Promise<boolean> => (await readFile(mutexIdPath, "utf8").catch(() => undefined)) === mutexId;
  try {
    await writeFile(mutexIdPath, mutexId, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    // The mutex was reclaimed before it was identified; give up this recovery attempt.
    if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      await rmdir(mutexPath).catch(() => undefined);
      throw error;
    }
    return false;
  }
  try {
    const isJudgedOrphan = async (): Promise<boolean> => {
      const current = await judgeOrphan(lockPath);
      return current !== undefined && (current.kind === "owner"
        ? judged.kind === "owner" && judged.owner.id === current.owner.id
        : judged.kind === "none");
    };
    if (await isJudgedOrphan()) {
      await hooks.beforeOrphanRemoval?.();
      // A recoverer paused past the mutex's age limit may have had the mutex reclaimed and the lock re-taken,
      // so the mutex and the orphan are re-checked before every removal attempt.
      await removeWhileOurs(lockPath, async () => await ownsMutex() && await isJudgedOrphan(), hooks);
    }
    return true;
  } finally {
    await removeWhileOurs(mutexPath, ownsMutex, hooks);
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

  const canonicalUrl = parsed.toString();
  gitSourceLocation(canonicalUrl);
  return canonicalUrl;
}

/** The GitHub tree/<ref>/<directory> shape, parsed once so the Catalog label cannot describe a different scope than the clone and tree walk use. */
export function githubTreeLocation(url: string): {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly ref: string;
  readonly directory?: string;
} | undefined {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").slice(1);
  if (parsed.hostname !== "github.com" || !["https:", "http:"].includes(parsed.protocol) || segments[2] !== "tree") {
    return undefined;
  }
  if (segments.length < 4 || !segments[0] || !segments[1] || !segments[3]) {
    throw new Error("GitHub directory Source URL must include an owner, repository, and ref");
  }
  const ref = validateGitRef(decodeURIComponent(segments[3]));
  if (ref.startsWith("-")) throw new Error("GitHub directory Source ref must not start with a dash");
  const directory = segments.length > 4
    ? validateSkillDirectoryPath(segments.slice(4).map((segment) => decodeURIComponent(segment)).join("/"))
    : undefined;
  const repository = `${segments[0]}/${segments[1]}`;
  parsed.pathname = `/${repository}`;
  return { repository, repositoryUrl: parsed.toString(), ref, ...(directory === undefined ? {} : { directory }) };
}

/** Keep the registered URL (and identity) while deriving Git transport and discovery scope. */
function gitSourceLocation(url: string): {
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly directory?: string;
} {
  return githubTreeLocation(url) ?? { repositoryUrl: url };
}

export function sourceIdForUrl(url: string): string {
  const canonicalUrl = canonicalizeGitSourceUrl(url);
  const digest = createHash("sha256").update(canonicalUrl, "utf8").digest("hex").slice(0, 24);
  return `git:${digest}`;
}
