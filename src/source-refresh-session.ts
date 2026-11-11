import type { GitSource } from "./git-source.js";
import type { SourceOperations, SourceRefreshOptions } from "./sources.js";

export type SourceRefreshStatus = "not-refreshed" | "refreshing" | "refreshed" | "failed";

export interface SourceRefreshState {
  readonly status: SourceRefreshStatus;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
}

export interface SourceRefreshSessionOptions {
  /** Injectable clock in milliseconds. */
  readonly now?: () => number;
}

/** In-memory refresh state of one TUI process; it never writes files. */
export interface SourceRefreshSession {
  refresh(source: GitSource, options?: Pick<SourceRefreshOptions, "force">): Promise<void>;
  refreshInBackground(sources: readonly GitSource[]): void;
  /** Immutable snapshot keyed by Source id; replaced on every change. */
  snapshot(): ReadonlyMap<string, SourceRefreshState>;
  subscribe(listener: () => void): () => void;
  now(): number;
}

export function createSourceRefreshSession(
  operations: SourceOperations,
  options: SourceRefreshSessionOptions = {},
): SourceRefreshSession {
  const now = options.now ?? Date.now;
  const empty: ReadonlyMap<string, SourceRefreshState> = new Map();
  const run = async (source: GitSource, background: boolean): Promise<void> => {
    await operations.refreshSource(source.id, { background });
  };
  return {
    refresh: (source) => run(source, false),
    refreshInBackground(sources) {
      for (const source of sources) void run(source, true).catch(() => undefined);
    },
    snapshot: () => empty,
    subscribe: () => () => undefined,
    now,
  };
}

export function withRefreshSession(operations: SourceOperations, _session: SourceRefreshSession): SourceOperations {
  return operations;
}
