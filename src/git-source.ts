import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface GitSource {
  readonly id: string;
  readonly kind: "git";
  readonly url: string;
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

export class GitSourceAccessError extends Error {
  constructor(source: GitSource, reason: string) {
    super(`Unable to refresh Git Source ${JSON.stringify(source.id)} from ${JSON.stringify(source.url)}: ${reason}`);
    this.name = "GitSourceAccessError";
  }
}

class NodeGitCommandRunner implements GitCommandRunner {
  run(command: string, args: readonly string[], options: GitCommandRunnerOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`);
        reject(new Error(`git command failed: ${detail}`));
      });
    });
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

    const destination = cachePathForSource(this.cachePath, source);
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

/** Compatibility aliases for callers that used the transport boundary name. */
export const RealGitSourceAccess = GitSourceAccessAdapter;
export const DeferredGitSourceAccess = GitSourceAccessAdapter;

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
  return path.join(cachePath, expectedId.slice("git:".length));
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
        throw new Error("the Source cache is busy; retry after the other refresh finishes");
      }
      await delay(SOURCE_LOCK_RETRY_MS);
    }
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
  if (/\s|[\u0000-\u001f\u007f\\]/u.test(input)) {
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
