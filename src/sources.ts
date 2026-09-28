import { realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  canonicalizeGitSourceUrl,
  GitSourceAccessAdapter,
  sourceIdForUrl,
  type GitSource,
  type GitSourceAccess,
} from "./git-source.js";
import { SourceStateStore } from "./source-state.js";
import {
  createSourceContentAccess,
  discoverSkillsFromSources,
  type SkillCandidate,
  type SkillTreeFile,
  type SourceContentAccess,
} from "./skill-discovery.js";
import type { ProjectSource } from "./project-manifest.js";

export interface BuiltInSource {
  readonly id: "builtin:agent-depot";
  readonly kind: "builtin";
  readonly name: "Agent Depot";
  readonly packageOwned: true;
}

export type Source = BuiltInSource | GitSource;

export const BUILT_IN_SOURCE: BuiltInSource = Object.freeze({
  id: "builtin:agent-depot",
  kind: "builtin",
  name: "Agent Depot",
  packageOwned: true,
});

export interface SourceOperationsOptions {
  readonly stateStore?: SourceStateStore;
  readonly statePath?: string;
  readonly gitAccess?: GitSourceAccess;
  readonly sourceContentAccess?: SourceContentAccess;
  readonly builtInRoot?: string;
  readonly gitCachePath?: string;
}

export class SourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`Source is not registered: ${sourceId}`);
    this.name = "SourceNotFoundError";
  }
}

export class BuiltInSourceError extends Error {
  constructor() {
    super("The package-owned built-in Source cannot be refreshed or changed");
    this.name = "BuiltInSourceError";
  }
}

export class SourceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSelectionError";
  }
}

export class SourceMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceMetadataError";
  }
}

/** A command supplied by an upstream adapter, never inferred from skill prose. */
export interface SourceInstallationMethod {
  readonly kind: "command";
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
}

export interface SourceInstallationContext {
  readonly source: Source;
  readonly skillPath: string;
  readonly projectRoot: string;
}

const SOURCE_METADATA_FILENAMES = Object.freeze([
  ".agent-depot.json",
  "agent-depot-method.json",
  "installation-method.json",
] as const);
const SOURCE_METADATA_MAX_BYTES = 64 * 1024;

export interface SourceOperations {
  addGitSource(url: string): Promise<GitSource>;
  listSources(): Promise<readonly Source[]>;
  refreshSource(sourceId: string): Promise<GitSource>;
  selectSources(sourceIds: readonly string[]): Promise<readonly Source[]>;
  /** Resolves a self-contained project Source without consulting global state. */
  resolveProjectSource?: (source: ProjectSource) => Promise<Source>;
  /** Refreshes a self-contained project Source after explicit CLI confirmation. */
  refreshProjectSource?: (source: ProjectSource) => Promise<Source>;
  /**
   * Reads structured upstream metadata from the supplied preview snapshot;
   * implementations must not replace it with a mutable latest read.
   */
  readInstallationMethod?: (
    source: Source,
    skillPath: string,
    previewTree?: readonly SkillTreeFile[],
  ) => Promise<unknown | undefined>;
  /** Executes only metadata returned by readInstallationMethod, using a no-shell adapter. */
  executeInstallationMethod?: (
    method: SourceInstallationMethod,
    context: SourceInstallationContext,
  ) => Promise<void>;
  /** Optional for embedders that only expose source management. */
  discoverSkills?: (sourceIds: readonly string[]) => Promise<readonly SkillCandidate[]>;
}

export interface SourceDiscoveryOperations extends SourceOperations {
  discoverSkills(sourceIds: readonly string[]): Promise<readonly SkillCandidate[]>;
}

export function createSourceOperations(options: SourceOperationsOptions = {}): SourceDiscoveryOperations {
  const stateStore = options.stateStore ?? new SourceStateStore(options.statePath);
  const gitAccess = options.gitAccess ?? new GitSourceAccessAdapter();
  const sourceContentAccess = options.sourceContentAccess ?? createSourceContentAccess({
    builtInRoot: options.builtInRoot,
    gitCachePath: options.gitCachePath ?? (gitAccess instanceof GitSourceAccessAdapter ? gitAccess.cachePath : undefined),
  });

  return {
    async addGitSource(url: string): Promise<GitSource> {
      const canonicalUrl = canonicalizeGitSourceUrl(url);
      const id = sourceIdForUrl(canonicalUrl);
      return stateStore.update((state) => {
        const existing = state.gitSources.find((source) => source.id === id);
        if (existing) {
          return { state, result: existing };
        }

        const source: GitSource = Object.freeze({ id, kind: "git", url: canonicalUrl });
        return {
          state: { version: 1, gitSources: [...state.gitSources, source] },
          result: source,
        };
      });
    },

    async listSources(): Promise<readonly Source[]> {
      const state = await stateStore.load();
      return Object.freeze([BUILT_IN_SOURCE, ...state.gitSources]);
    },

    async refreshSource(sourceId: string): Promise<GitSource> {
      if (sourceId === BUILT_IN_SOURCE.id) {
        throw new BuiltInSourceError();
      }

      const state = await stateStore.load();
      const source = state.gitSources.find((candidate) => candidate.id === sourceId);
      if (!source) {
        throw new SourceNotFoundError(sourceId);
      }

      await gitAccess.refresh(source);
      return source;
    },

    async selectSources(sourceIds: readonly string[]): Promise<readonly Source[]> {
      if (sourceIds.length === 0) {
        throw new SourceSelectionError("At least one Source must be selected explicitly");
      }

      const sources = await this.listSources();
      const byId = new Map(sources.map((source) => [source.id, source]));
      const selected: Source[] = [];
      const seen = new Set<string>();
      for (const sourceId of sourceIds) {
        if (typeof sourceId !== "string" || sourceId.length === 0 || seen.has(sourceId)) {
          continue;
        }
        const source = byId.get(sourceId);
        if (!source) {
          throw new SourceNotFoundError(sourceId);
        }
        seen.add(sourceId);
        selected.push(source);
      }

      if (selected.length === 0) {
        throw new SourceSelectionError("At least one valid Source must be selected explicitly");
      }
      return Object.freeze(selected);
    },

    async resolveProjectSource(projectSource: ProjectSource): Promise<Source> {
      return resolveProjectSource(projectSource);
    },

    async refreshProjectSource(projectSource: ProjectSource): Promise<Source> {
      const source = resolveProjectSource(projectSource);
      if (source.kind === "builtin") {
        throw new BuiltInSourceError();
      }
      await gitAccess.refresh(source);
      return source;
    },

    async readInstallationMethod(source, skillPath, previewTree): Promise<unknown | undefined> {
      return previewTree === undefined
        ? readSourceInstallationMethod(sourceContentAccess, source, skillPath)
        : readInstallationMethodFromSkillTree(previewTree, skillPath);
    },

    async executeInstallationMethod(method, context): Promise<void> {
      await executeSourceInstallationMethod(method, context);
    },

    async discoverSkills(sourceIds: readonly string[]): Promise<readonly SkillCandidate[]> {
      const sources = await this.selectSources(sourceIds);
      return discoverSkillsFromSources(sources, sourceContentAccess);
    },
  };
}

/** Converts persisted project identity into a read-only Source identity. */
export function resolveProjectSource(projectSource: ProjectSource): Source {
  if (projectSource.kind === "builtin") {
    return BUILT_IN_SOURCE;
  }
  if ("url" in projectSource) {
    const id = sourceIdForUrl(projectSource.url);
    return Object.freeze({
      id,
      kind: "git",
      url: projectSource.url,
      ...(projectSource.ref === undefined ? {} : { ref: projectSource.ref }),
    });
  }
  throw new SourceMetadataError(
    "Project Source paths are not independently resolvable by the Git-only V1 adapter; use a project-relative Source path with a supported adapter",
  );
}

/**
 * Validates the only external-method shape the CLI may accept. Unknown fields,
 * shell strings, empty argv, and control characters all fail closed.
 */
export function parseSourceInstallationMethod(value: unknown): SourceInstallationMethod {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceMetadataError("upstream installation metadata must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "kind" && key !== "argv" && key !== "cwd")) {
    throw new SourceMetadataError("upstream installation metadata contains unsupported fields");
  }
  if (record.kind !== "command" || !Array.isArray(record.argv) || record.argv.length === 0 ||
    record.argv.some((part) => typeof part !== "string" || part.length === 0 || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new SourceMetadataError("upstream installation metadata must define a non-empty argv array without control characters");
  }
  const executable = record.argv[0];
  if (typeof executable !== "string" || !/^[A-Za-z0-9._+-]+$/u.test(executable) ||
    isShellInterpreter(executable)) {
    throw new SourceMetadataError("upstream installation metadata executable is not a safe no-shell command name");
  }
  if (record.argv.some((part) => typeof part === "string" && /[;&|<>$`]/u.test(part))) {
    throw new SourceMetadataError("upstream installation metadata contains shell syntax");
  }
  if (typeof record.cwd === "string" && (record.cwd.length === 0 || /[\u0000-\u001f\u007f]/u.test(record.cwd) ||
    path.posix.isAbsolute(record.cwd) || record.cwd === ".." || record.cwd.startsWith("../") || record.cwd.includes("\\"))) {
    throw new SourceMetadataError("upstream installation metadata cwd is unsafe");
  }
  if (record.cwd !== undefined && typeof record.cwd !== "string") {
    throw new SourceMetadataError("upstream installation metadata cwd must be a string");
  }
  return Object.freeze({
    kind: "command",
    argv: Object.freeze([...record.argv] as [string, ...string[]]),
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
  });
}

/** Executes a validated method with an argument vector and no shell. */
export async function executeSourceInstallationMethod(
  method: SourceInstallationMethod,
  context: SourceInstallationContext,
): Promise<void> {
  const projectRoot = await realpath(path.resolve(context.projectRoot)).catch((error: unknown) => {
    throw new SourceMetadataError(`cannot resolve the project root: ${errorMessage(error)}`);
  });
  const requestedCwd = path.resolve(projectRoot, method.cwd ?? ".");
  const cwd = await realpath(requestedCwd).catch((error: unknown) => {
    throw new SourceMetadataError(`cannot resolve the installation method cwd: ${errorMessage(error)}`);
  });
  const relative = path.relative(projectRoot, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SourceMetadataError("upstream installation method cwd escapes the project root after realpath resolution");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(method.argv[0], [...method.argv.slice(1)], {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new SourceMetadataError(
        `upstream installation method failed${signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

function isShellInterpreter(executable: string): boolean {
  const normalized = executable.toLowerCase();
  return new Set([
    "sh", "sh.exe", "bash", "bash.exe", "zsh", "zsh.exe", "fish", "fish.exe",
    "cmd", "cmd.exe", "command.com", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  ]).has(normalized) || /\.(?:bat|cmd|com|ps1)$/u.test(normalized);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSourceInstallationMethod(
  sourceContentAccess: SourceContentAccess,
  source: Source,
  skillPath: string,
): Promise<unknown | undefined> {
  if (!sourceContentAccess.readSkillTree) {
    return undefined;
  }
  return readInstallationMethodFromSkillTree(
    await sourceContentAccess.readSkillTree(source, skillPath),
    skillPath,
  );
}

/** Reads method metadata from one already captured Skill tree snapshot. */
export function readInstallationMethodFromSkillTree(
  files: readonly SkillTreeFile[],
  skillPath: string,
): unknown | undefined {
  const prefix = `${skillPath}/`;
  const metadataFiles = files.filter((file) => file.path.startsWith(prefix) &&
    SOURCE_METADATA_FILENAMES.includes(file.path.slice(prefix.length) as typeof SOURCE_METADATA_FILENAMES[number]));
  if (metadataFiles.length > 1) {
    throw new SourceMetadataError("selected Skill contains more than one installation metadata file");
  }
  const metadataFile = metadataFiles[0];
  if (!metadataFile) {
    return undefined;
  }
  if (metadataFile.content.byteLength > SOURCE_METADATA_MAX_BYTES) {
    throw new SourceMetadataError("installation metadata file exceeds the safe size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(metadataFile.content).toString("utf8")) as unknown;
  } catch (error) {
    throw new SourceMetadataError(`installation metadata file is not valid JSON: ${errorMessage(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceMetadataError("installation metadata file must contain a JSON object");
  }
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "method") ? record.method : value;
}
