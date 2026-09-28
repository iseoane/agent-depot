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
  type SourceContentAccess,
} from "./skill-discovery.js";

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

export interface SourceOperations {
  addGitSource(url: string): Promise<GitSource>;
  listSources(): Promise<readonly Source[]>;
  refreshSource(sourceId: string): Promise<GitSource>;
  selectSources(sourceIds: readonly string[]): Promise<readonly Source[]>;
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

    async discoverSkills(sourceIds: readonly string[]): Promise<readonly SkillCandidate[]> {
      const sources = await this.selectSources(sourceIds);
      return discoverSkillsFromSources(sources, sourceContentAccess);
    },
  };
}
