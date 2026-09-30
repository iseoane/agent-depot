import { realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.js";

import {
  canonicalizeGitSourceUrl,
  GitSourceAccessAdapter,
  sourceIdForUrl,
  type GitSource,
  type GitSourceAccess,
} from "./git-source.js";
import { defaultSourceStatePath, SourceStateStore } from "./source-state.js";
import {
  createSourceContentAccess,
  discoverSkillsFromSources,
  type SkillCandidate,
  type SkillTreeFile,
  type SourceContentAccess,
  type SourceSkillTreeSnapshot,
} from "./skill-discovery.js";
import {
  AGENT_DEPOT_PACKAGE_VERSION,
  parsePortableInstallationMethod,
  type ProjectSkillSelection,
  type ProjectSource,
  type ResolvedVersionEvidence,
  type SourceInstallationMethod,
} from "./project-manifest.js";
import type { UserGlobalSkillInstallation } from "./source-state.js";

export type { SourceInstallationMethod } from "./project-manifest.js";

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
  /** Injectable home directory used when deriving the default per-user state path. */
  readonly homeDirectory?: string;
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

/** Context supplied when executing a validated installation method. */
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

export interface UserGlobalSkillMigration {
  /** Existing user-global record selected from the old Source. */
  readonly from: UserGlobalSkillInstallation;
  /** Replacement record whose Source identity is the separately registered new Source. */
  readonly to: UserGlobalSkillInstallation;
}

export interface SourceOperations {
  addGitSource(url: string): Promise<GitSource>;
  listSources(): Promise<readonly Source[]>;
  refreshSource(sourceId: string): Promise<GitSource>;
  /** Removes a Git Source and, when requested, its selected user-global records. */
  removeGitSource?: (sourceId: string, installations?: readonly UserGlobalSkillInstallation[]) => Promise<void>;
  /** Rewrites only explicitly selected user-global identities; it never moves files or project manifests. */
  migrateUserGlobalInstallations?: (
    oldSourceId: string,
    newSourceId: string,
    migrations: readonly UserGlobalSkillMigration[],
  ) => Promise<void>;
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
  /** Reads trustworthy resolved version evidence without refreshing a Source. */
  resolveSourceVersion?: (source: Source) => Promise<ResolvedVersionEvidence | undefined>;
  /** Reads one immutable Skill tree and its version evidence without refreshing a Source. */
  readSkillTreeSnapshot?: (source: Source, skillPath: string) => Promise<SourceSkillTreeSnapshot>;
  /** Shared per-user records for user-global Skill installations. */
  listUserGlobalInstallations?: () => Promise<readonly UserGlobalSkillInstallation[]>;
  addUserGlobalInstallation?: (selection: ProjectSkillSelection) => Promise<void>;
  /** Replaces one persisted user-global record without changing its identity. */
  updateUserGlobalInstallation?: (selection: ProjectSkillSelection) => Promise<void>;
  /** Removes explicitly selected user-global records after their files are safely removed. */
  removeUserGlobalInstallations?: (selections: readonly UserGlobalSkillInstallation[]) => Promise<void>;
  /** Removes the user-global catalog/configuration state but never the Git cache. */
  removeCatalogData?: () => Promise<void>;
}

export interface SourceDiscoveryOperations extends SourceOperations {
  discoverSkills(sourceIds: readonly string[]): Promise<readonly SkillCandidate[]>;
}

export function createSourceOperations(options: SourceOperationsOptions = {}): SourceDiscoveryOperations {
  const stateStore = options.stateStore ?? new SourceStateStore(
    options.statePath ?? defaultSourceStatePath(process.env, process.platform, options.homeDirectory),
  );
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
          state: {
            version: 1,
            gitSources: [...state.gitSources, source],
            userGlobalInstallations: state.userGlobalInstallations,
          },
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

    async removeGitSource(sourceId: string, installations: readonly UserGlobalSkillInstallation[] = []): Promise<void> {
      if (sourceId === BUILT_IN_SOURCE.id) {
        throw new BuiltInSourceError();
      }

      await stateStore.update((state) => {
        const source = state.gitSources.find((candidate) => candidate.id === sourceId);
        if (!source) {
          throw new SourceNotFoundError(sourceId);
        }

        const requested = new Set(installations.map(userGlobalInstallationIdentity));
        for (const installation of installations) {
          if (sourceIdForUserGlobalInstallation(installation) !== sourceId ||
            !state.userGlobalInstallations.some((candidate) => userGlobalInstallationIdentity(candidate) === userGlobalInstallationIdentity(installation))) {
            throw new SourceSelectionError(
              `User-global Skill ${JSON.stringify(installation.path)} is not a dependent installation of Source ${JSON.stringify(sourceId)}`,
            );
          }
        }

        return {
          state: {
            version: 1,
            gitSources: state.gitSources.filter((candidate) => candidate.id !== sourceId),
            userGlobalInstallations: state.userGlobalInstallations.filter((candidate) => !requested.has(userGlobalInstallationIdentity(candidate))),
          },
          result: undefined,
        };
      });
    },

    async migrateUserGlobalInstallations(
      oldSourceId: string,
      newSourceId: string,
      migrations: readonly UserGlobalSkillMigration[],
    ): Promise<void> {
      if (oldSourceId === newSourceId) {
        throw new SourceSelectionError("Source migration requires two different registered Git Sources");
      }

      await stateStore.update((state) => {
        const oldSource = state.gitSources.find((source) => source.id === oldSourceId);
        const newSource = state.gitSources.find((source) => source.id === newSourceId);
        if (!oldSource) throw new SourceNotFoundError(oldSourceId);
        if (!newSource) throw new SourceNotFoundError(newSourceId);

        const sourceIds = (selection: UserGlobalSkillInstallation): string => sourceIdForUserGlobalInstallation(selection);
        const existingIdentities = new Set(state.userGlobalInstallations.map(userGlobalInstallationIdentity));
        const selectedIdentities = new Set<string>();
        const replacementIdentities = new Set<string>();
        for (const migration of migrations) {
          const fromIdentity = userGlobalInstallationIdentity(migration.from);
          const toIdentity = userGlobalInstallationIdentity(migration.to);
          if (selectedIdentities.has(fromIdentity)) {
            throw new SourceSelectionError(`User-global Skill ${JSON.stringify(migration.from.path)} was selected more than once`);
          }
          selectedIdentities.add(fromIdentity);
          if (sourceIds(migration.from) !== oldSourceId || !existingIdentities.has(fromIdentity)) {
            throw new SourceSelectionError(
              `User-global Skill ${JSON.stringify(migration.from.path)} is not a dependent installation of Source ${JSON.stringify(oldSourceId)}`,
            );
          }
          if (sourceIds(migration.to) !== newSourceId) {
            throw new SourceSelectionError(
              `User-global Skill ${JSON.stringify(migration.to.path)} does not belong to replacement Source ${JSON.stringify(newSourceId)}`,
            );
          }
          if (replacementIdentities.has(toIdentity)) {
            throw new SourceSelectionError(`Replacement identity ${JSON.stringify(migration.to.path)} was selected more than once`);
          }
          replacementIdentities.add(toIdentity);
          const collision = existingIdentities.has(toIdentity) && !selectedIdentities.has(toIdentity);
          if (collision) {
            throw new SourceSelectionError(
              `Cannot migrate Skill ${JSON.stringify(migration.from.path)}: replacement identity ${JSON.stringify(migration.to.path)} already exists`,
            );
          }
        }

        const replacements = new Map(migrations.map((migration) => [userGlobalInstallationIdentity(migration.from), migration.to]));
        return {
          state: {
            version: 1,
            gitSources: state.gitSources,
            userGlobalInstallations: state.userGlobalInstallations.map((installation) =>
              replacements.get(userGlobalInstallationIdentity(installation)) ?? installation,
            ),
          },
          result: undefined,
        };
      });
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

    async resolveSourceVersion(source: Source): Promise<ResolvedVersionEvidence | undefined> {
      if (sourceContentAccess.readResolvedVersion) {
        return sourceContentAccess.readResolvedVersion(source);
      }
      return source.kind === "builtin" && AGENT_DEPOT_PACKAGE_VERSION !== undefined
        ? Object.freeze({ kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION })
        : undefined;
    },

    ...(sourceContentAccess.readSkillTreeSnapshot === undefined
      ? {}
      : {
        readSkillTreeSnapshot: (source: Source, skillPath: string): Promise<SourceSkillTreeSnapshot> =>
          sourceContentAccess.readSkillTreeSnapshot!(source, skillPath),
      }),

    async discoverSkills(sourceIds: readonly string[]): Promise<readonly SkillCandidate[]> {
      const sources = await this.selectSources(sourceIds);
      return discoverSkillsFromSources(sources, sourceContentAccess);
    },

    async listUserGlobalInstallations(): Promise<readonly UserGlobalSkillInstallation[]> {
      return (await stateStore.load()).userGlobalInstallations;
    },

    async addUserGlobalInstallation(selection: ProjectSkillSelection): Promise<void> {
      if (selection.installation === undefined) {
        throw new SourceSelectionError(
          `User-global Skill ${JSON.stringify(selection.path)} must include an installation location`,
        );
      }
      await stateStore.update((state) => {
        const identity = JSON.stringify([selection.source, selection.path]);
        if (state.userGlobalInstallations.some((candidate) => JSON.stringify([candidate.source, candidate.path]) === identity)) {
          throw new SourceSelectionError(`User-global Skill ${JSON.stringify(selection.path)} is already recorded`);
        }
        return {
          state: {
            version: 1,
            gitSources: state.gitSources,
            userGlobalInstallations: [...state.userGlobalInstallations, selection],
          },
          result: undefined,
        };
      });
    },

    async updateUserGlobalInstallation(selection: ProjectSkillSelection): Promise<void> {
      if (selection.installation === undefined) {
        throw new SourceSelectionError(
          `User-global Skill ${JSON.stringify(selection.path)} must include an installation location`,
        );
      }
      await stateStore.update((state) => {
        const identity = JSON.stringify([selection.source, selection.path]);
        const index = state.userGlobalInstallations.findIndex((candidate) =>
          JSON.stringify([candidate.source, candidate.path]) === identity,
        );
        if (index < 0) {
          throw new SourceSelectionError(`User-global Skill ${JSON.stringify(selection.path)} is not recorded`);
        }
        const installations = [...state.userGlobalInstallations];
        installations[index] = selection;
        return {
          state: {
            version: 1,
            gitSources: state.gitSources,
            userGlobalInstallations: installations,
          },
          result: undefined,
        };
      });
    },

    async removeUserGlobalInstallations(selections: readonly UserGlobalSkillInstallation[]): Promise<void> {
      await stateStore.update((state) => {
        const selectedIdentities = new Set<string>();
        for (const selection of selections) {
          const identity = userGlobalInstallationIdentity(selection);
          if (selectedIdentities.has(identity)) {
            throw new SourceSelectionError(`User-global Skill ${JSON.stringify(selection.path)} was selected more than once`);
          }
          selectedIdentities.add(identity);
          if (!state.userGlobalInstallations.some((candidate) => userGlobalInstallationIdentity(candidate) === identity)) {
            throw new SourceSelectionError(`User-global Skill ${JSON.stringify(selection.path)} is not recorded`);
          }
        }
        return {
          state: {
            version: 1,
            gitSources: state.gitSources,
            userGlobalInstallations: state.userGlobalInstallations.filter(
              (installation) => !selectedIdentities.has(userGlobalInstallationIdentity(installation)),
            ),
          },
          result: undefined,
        };
      });
    },

    async removeCatalogData(): Promise<void> {
      await stateStore.remove();
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
  return parsePortableInstallationMethod(value, {
    label: "upstream installation metadata",
    error: (message) => new SourceMetadataError(message),
  });
}

/** Resolves and validates a method cwd before any managed tree is replaced. */
export async function resolveSourceInstallationMethodCwd(
  method: SourceInstallationMethod,
  projectRootInput: string,
): Promise<string> {
  const projectRoot = await realpath(path.resolve(projectRootInput)).catch((error: unknown) => {
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
  return cwd;
}

/** Executes a validated method with an argument vector and no shell. */
export async function executeSourceInstallationMethod(
  method: SourceInstallationMethod,
  context: SourceInstallationContext,
): Promise<void> {
  const cwd = await resolveSourceInstallationMethodCwd(method, context.projectRoot);
  const result = await runProcess(method.argv[0], method.argv.slice(1), { cwd });
  if (result.code === 0) {
    return;
  }
  const { code, signal, stderr } = result;
  throw new SourceMetadataError(
    `upstream installation method failed${signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userGlobalInstallationIdentity(selection: UserGlobalSkillInstallation): string {
  return JSON.stringify([selection.source, selection.path]);
}

function sourceIdForUserGlobalInstallation(selection: UserGlobalSkillInstallation): string {
  return selection.source.kind === "builtin"
    ? selection.source.id
    : "url" in selection.source
      ? sourceIdForUrl(selection.source.url)
      : "";
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
