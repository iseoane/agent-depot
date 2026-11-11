import type { GitSource } from "./git-source.js";
import { projectSourceOf, resolveProjectSource, type SourceOperations, type SourceRefreshOptions } from "./sources.js";

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
  /** Joins a refresh in flight; otherwise reuses a success younger than an hour unless forced. */
  refresh(source: GitSource, options?: Pick<SourceRefreshOptions, "force">): Promise<void>;
  /** Queues refreshes that cannot prompt; callers never wait for the queue and failures only update the state. */
  refreshInBackground(sources: readonly GitSource[]): void;
  /** Immutable snapshot keyed by Source id; replaced on every change. Absent means not refreshed. */
  snapshot(): ReadonlyMap<string, SourceRefreshState>;
  subscribe(listener: () => void): () => void;
  now(): number;
  /** Drops queued background refreshes; refreshes already running finish. */
  stop(): void;
}

/** ADR 0004 (amended): how long a refresh made by this process stands in for the one a preview needs. */
const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
const BACKGROUND_CONCURRENCY = 2;

export function createSourceRefreshSession(
  operations: SourceOperations,
  options: SourceRefreshSessionOptions = {},
): SourceRefreshSession {
  const now = options.now ?? Date.now;
  let states: ReadonlyMap<string, SourceRefreshState> = new Map();
  const inFlight = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const queue: GitSource[] = [];
  let backgroundRunning = 0;

  const setState = (sourceId: string, state: SourceRefreshState) => {
    states = new Map(states).set(sourceId, state);
    for (const listener of listeners) listener();
  };

  // The project refresh carries the Source's own URL, so it also covers Sources missing from the registry.
  const refreshReally = (source: GitSource, background: boolean): Promise<unknown> => operations.refreshProjectSource
    ? operations.refreshProjectSource(projectSourceOf(source), { background })
    : operations.refreshSource(source.id, { background });

  const start = (source: GitSource, background: boolean): Promise<void> => {
    const startedAt = now();
    setState(source.id, { status: "refreshing", startedAt });
    const running = refreshReally(source, background).then(
      () => {
        inFlight.delete(source.id);
        setState(source.id, { status: "refreshed", startedAt, finishedAt: now() });
      },
      (error: unknown) => {
        inFlight.delete(source.id);
        setState(source.id, { status: "failed", startedAt, finishedAt: now(), error: error instanceof Error ? error.message : String(error) });
        throw error;
      },
    );
    inFlight.set(source.id, running);
    return running;
  };

  const isFresh = (sourceId: string): boolean => {
    const state = states.get(sourceId);
    return state?.status === "refreshed" && state.finishedAt !== undefined && now() - state.finishedAt < FRESHNESS_WINDOW_MS;
  };

  const refresh = (source: GitSource, background: boolean, force: boolean): Promise<void> => {
    const running = inFlight.get(source.id);
    if (running) return running;
    if (!force && isFresh(source.id)) return Promise.resolve();
    return start(source, background);
  };

  const drain = () => {
    while (backgroundRunning < BACKGROUND_CONCURRENCY && queue.length > 0) {
      const source = queue.shift()!;
      backgroundRunning += 1;
      void refresh(source, true, false)
        .catch(() => undefined)
        .finally(() => {
          backgroundRunning -= 1;
          drain();
        });
    }
  };

  return {
    refresh: (source, refreshOptions = {}) => refresh(source, false, refreshOptions.force === true),
    refreshInBackground(sources) {
      queue.push(...sources);
      drain();
    },
    snapshot: () => states,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now,
    stop() {
      queue.length = 0;
    },
  };
}

/**
 * Routes `refreshSource` and `refreshProjectSource` through the session, so previews, Updates and
 * Packages share and reuse refreshes. Built-in and unregistered ids keep the plain behavior and errors.
 */
export function withRefreshSession(operations: SourceOperations, session: SourceRefreshSession): SourceOperations {
  const refreshProjectSource = operations.refreshProjectSource;
  return {
    ...operations,
    async refreshSource(sourceId, options) {
      const source = (await operations.listSources()).find((candidate): candidate is GitSource => candidate.kind === "git" && candidate.id === sourceId);
      if (!source) return operations.refreshSource(sourceId, options);
      await session.refresh(source, options);
      return source;
    },
    ...(refreshProjectSource === undefined ? {} : {
      async refreshProjectSource(projectSource, options) {
        const source = resolveProjectSource(projectSource);
        if (source.kind !== "git") return refreshProjectSource(projectSource, options);
        await session.refresh(source, options);
        return source;
      },
    }),
  };
}
