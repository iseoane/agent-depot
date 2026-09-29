import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import { canonicalizeGitSourceUrl, sourceIdForUrl, type GitSource } from "./git-source.js";
import { parseProjectManifest, type ProjectSkillSelection } from "./project-manifest.js";

export type UserGlobalSkillInstallation = ProjectSkillSelection;

export interface PersistedSourceState {
  readonly version: 1;
  readonly gitSources: readonly GitSource[];
  readonly userGlobalInstallations: readonly UserGlobalSkillInstallation[];
}

const EMPTY_STATE: PersistedSourceState = Object.freeze({
  version: 1,
  gitSources: Object.freeze([]),
  userGlobalInstallations: Object.freeze([]),
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export class SourceStateError extends Error {
  constructor(statePath: string, reason: string) {
    super(`Source state at ${JSON.stringify(statePath)} is invalid: ${reason}. The file was not modified; inspect or repair it before retrying.`);
    this.name = "SourceStateError";
  }
}

export class SourceStateLockError extends Error {
  constructor(statePath: string) {
    super(`Source state at ${JSON.stringify(statePath)} is busy; no changes were made. Retry after the other process finishes.`);
    this.name = "SourceStateLockError";
  }
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

function parseState(value: unknown, statePath: string): PersistedSourceState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceStateError(statePath, "the root value must be an object");
  }

  const candidate = value as { version?: unknown; gitSources?: unknown; userGlobalInstallations?: unknown };
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== "version" && key !== "gitSources" && key !== "userGlobalInstallations")) {
    throw new SourceStateError(statePath, "the state contains unsupported fields");
  }
  if (candidate.version !== 1) {
    throw new SourceStateError(statePath, "the state version is unsupported");
  }
  if (!Array.isArray(candidate.gitSources)) {
    throw new SourceStateError(statePath, "gitSources must be an array");
  }
  if (candidate.userGlobalInstallations !== undefined && !Array.isArray(candidate.userGlobalInstallations)) {
    throw new SourceStateError(statePath, "userGlobalInstallations must be an array");
  }

  const gitSources: GitSource[] = [];
  const ids = new Set<string>();
  for (const [index, item] of candidate.gitSources.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new SourceStateError(statePath, `gitSources[${index}] must be an object`);
    }

    const source = item as { id?: unknown; kind?: unknown; url?: unknown };
    const sourceKeys = Object.keys(source);
    if (sourceKeys.some((key) => key !== "id" && key !== "kind" && key !== "url")) {
      throw new SourceStateError(statePath, `gitSources[${index}] contains unsupported fields`);
    }
    if (source.kind !== "git" || !isNonEmptyString(source.id) || !isNonEmptyString(source.url)) {
      throw new SourceStateError(statePath, `gitSources[${index}] is not a valid Git Source`);
    }

    let url: string;
    try {
      url = canonicalizeGitSourceUrl(source.url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the URL is invalid";
      throw new SourceStateError(statePath, `gitSources[${index}] has an invalid URL (${reason})`);
    }

    const id = sourceIdForUrl(url);
    if (source.id !== id) {
      throw new SourceStateError(statePath, `gitSources[${index}] has an invalid identity`);
    }
    if (ids.has(id)) {
      throw new SourceStateError(statePath, `gitSources[${index}] duplicates another Source`);
    }
    ids.add(id);
    gitSources.push(Object.freeze({ id, kind: "git", url }));
  }

  const userGlobalInstallations: UserGlobalSkillInstallation[] = [];
  const installationIdentities = new Set<string>();
  for (const [index, item] of (candidate.userGlobalInstallations ?? []).entries()) {
    try {
      const parsed = parseProjectManifest({ version: 1, skills: [item] }, statePath).skills[0];
      if (!parsed) {
        throw new Error("the installation record is missing");
      }
      if (parsed.installation === undefined) {
        throw new Error("the installation record must include an installation location");
      }
      const identity = JSON.stringify([parsed.source, parsed.path]);
      if (installationIdentities.has(identity)) {
        throw new Error("the installation duplicates another user-global Skill");
      }
      installationIdentities.add(identity);
      userGlobalInstallations.push(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the installation record is invalid";
      throw new SourceStateError(statePath, `userGlobalInstallations[${index}] is invalid (${reason})`);
    }
  }

  return Object.freeze({
    version: 1,
    gitSources: Object.freeze(gitSources),
    userGlobalInstallations: Object.freeze(userGlobalInstallations),
  });
}

export function defaultSourceStatePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (platform === "win32") {
    const appData = environment.APPDATA || environment.LOCALAPPDATA;
    return pathApi.join(appData || pathApi.join(homeDirectory, "AppData", "Roaming"), "Agent Depot", "sources.json");
  }

  const stateHome = environment.XDG_STATE_HOME;
  return pathApi.join(
    stateHome && pathApi.isAbsolute(stateHome) ? stateHome : pathApi.join(homeDirectory, ".local", "state"),
    "agent-depot",
    "sources.json",
  );
}

export class SourceStateStore {
  readonly path: string;

  constructor(statePath: string = defaultSourceStatePath()) {
    this.path = statePath;
  }

  async load(): Promise<PersistedSourceState> {
    const release = await this.acquireLock();
    try {
      return await this.loadUnlocked();
    } finally {
      await release();
    }
  }

  async update<T>(
    mutate: (state: PersistedSourceState) => Promise<{ readonly state: PersistedSourceState; readonly result: T }> | {
      readonly state: PersistedSourceState;
      readonly result: T;
    },
  ): Promise<T> {
    const release = await this.acquireLock();
    try {
      const state = await this.loadUnlocked();
      const update = await mutate(state);
      await this.saveUnlocked(update.state);
      return update.result;
    } finally {
      await release();
    }
  }

  async save(state: PersistedSourceState): Promise<void> {
    const release = await this.acquireLock();
    try {
      await this.saveUnlocked(state);
    } finally {
      await release();
    }
  }

  /** Removes the persisted catalog/configuration file without touching caches. */
  async remove(): Promise<void> {
    const release = await this.acquireLock();
    try {
      await unlink(this.path).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    } finally {
      await release();
    }
  }

  private async loadUnlocked(): Promise<PersistedSourceState> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return EMPTY_STATE;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the JSON could not be parsed";
      throw new SourceStateError(this.path, `malformed JSON (${reason})`);
    }

    return parseState(value, this.path);
  }

  private async saveUnlocked(state: PersistedSourceState): Promise<void> {
    const normalized = parseState(state, this.path);
    await mkdir(path.dirname(this.path), { recursive: true });
    const contents = `${JSON.stringify(normalized, null, 2)}\n`;
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
      try {
        await rename(temporaryPath, this.path);
      } catch (error) {
        if (!isWindowsReplaceError(error)) {
          throw error;
        }
        // Windows may not replace an existing file with rename. The lock makes
        // this fallback safe from concurrent read-modify-write operations.
        await writeFile(this.path, contents, "utf8");
      }
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isMissingFile(error)) {
          throw error;
        }
      });
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.path}.lock`;
    await mkdir(path.dirname(this.path), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

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
        if (Date.now() >= deadline) {
          throw new SourceStateLockError(this.path);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isWindowsReplaceError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY";
}
