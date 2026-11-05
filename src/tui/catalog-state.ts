import type { Key } from "ink";
import type { AppEntry, AppInspection, AppOperations } from "../app-flow.js";
import { useCallback, useEffect, useReducer, useRef, useState, type MutableRefObject } from "react";

import { packageSelectionFor, selectionKey, type BundleDescriptor } from "../package-model.js";
import type { DiscoveredBundle } from "../package-owned-skills.js";
import type { SkillCandidate } from "../skill-discovery.js";
import { projectSourceOf, type Source, type SourceOperations } from "../sources.js";
import type { ActionMode } from "./catalog-actions.js";
import { filterReducer, initialFilter, type FilterEvent, type FilterState } from "./catalog-filter.js";
import { loadInstalledSkills, NO_INSTALLED, type InstalledSkills } from "./catalog-installs.js";
import { sourceLabel, type BundleEntry } from "./catalog-tree.js";
import { packageOperationsOf, type TuiEnvironment } from "./environment.js";
import type { ViewRetention } from "./view-retention.js";

export type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly skills: readonly SkillCandidate[]; readonly bundles: readonly BundleEntry[]; readonly activeBundles: readonly BundleDescriptor[]; readonly warnings: readonly string[]; readonly sources: readonly Source[]; /** Kept from an earlier visit and being reloaded. */ readonly stale?: boolean };

export interface CatalogAppRow {
  readonly entry: AppEntry;
  readonly inspection: AppInspection;
}

export type CatalogAppsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly rows: readonly CatalogAppRow[]; readonly error?: string; readonly stale?: boolean };

/** Discovers the Skills of one Source, or of all of them, and again whenever those inputs or `reloadKey` change. */
export function useCatalogSkills(operations: SourceOperations, sourceId: string | undefined, all: boolean, env: TuiEnvironment, reloadKey = 0, retention?: ViewRetention): LoadState {
  const key = `${sourceId ?? ""}|${all}`;
  /** The last result of this scope, shown while it is discovered again. */
  const retained = (): LoadState => {
    const kept = retention?.catalogKey === key ? retention.catalogSkills : undefined;
    return kept ? { ...kept, stale: true } : { status: "loading" };
  };
  const [state, setState] = useState<LoadState>(retained);
  useEffect(() => {
    let cancelled = false;
    const generation = retention?.generation;
    if (!operations.discoverSkills) {
      setState({ status: "error", message: "Discovery is not supported by the configured operations" });
      return;
    }
    setState(retained());
    void (async () => {
      try {
        const sources = await operations.listSources();
        const ids = all || sourceId === undefined
          ? sources.map((source) => source.id)
          : [sourceId];
        const labels = new Map(sources.map((source) => [source.id, sourceLabel(source)]));
        const skills: SkillCandidate[] = [];
        let bundles: BundleEntry[] = [];
        const discovered: DiscoveredBundle[] = [];
        const warnings: string[] = [];
        try {
          skills.push(...await operations.discoverSkills!(ids));
        } catch {
          // Discovery is read-only: isolate failures without silently refreshing Sources.
          for (const id of ids) {
            try {
              skills.push(...await operations.discoverSkills!([id]));
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              warnings.push(`Source ${labels.get(id) ?? id} unavailable: ${detail}. Go to Sources (1) and refresh it with r.`);
            }
          }
        }
        // Bundles read the same snapshots and group under their Source; one failure never hides the Skills.
        const packages = packageOperationsOf(env);
        for (const id of ids) {
          const source = sources.find((candidate) => candidate.id === id);
          if (source === undefined) continue;
          try {
            const projectSource = projectSourceOf(source);
            for (const descriptor of await packages.discover([id])) {
              // A Package Agent Depot cannot install is not a choice; its warning stays in `package inspect`.
              if (!descriptor.installable) continue;
              bundles.push({ sourceId: id, selection: packageSelectionFor(descriptor, projectSource), descriptor });
              discovered.push({ source: projectSource, descriptor });
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            warnings.push(`Source ${labels.get(id) ?? id} Packages unavailable: ${detail}`);
          }
        }
        // Ownership is selection- or host-gated, so a loose Skill stays normal until its Package is active.
        let activeBundles: readonly BundleDescriptor[] = [];
        try {
          const active = await packages.activeBundles(discovered);
          const installedKeys = new Set(active
            .filter(bundle => bundle.reason === "installed" || bundle.reason === "selected-and-installed")
            .map(bundle => selectionKey(bundle.selection)));
          bundles = bundles.filter(entry => !installedKeys.has(selectionKey(entry.selection)));
          activeBundles = active.map(bundle => bundle.descriptor);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(`Package ownership unavailable: ${detail}`);
        }
        const ready = { status: "ready", skills, bundles, activeBundles, warnings, sources } as const;
        // A result that began before an invalidation may predate the change, so it is not kept.
        if (!cancelled && retention && retention.generation === generation) {
          retention.catalogKey = key;
          retention.catalogSkills = ready;
        }
        if (!cancelled) setState(ready);
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [operations, sourceId, all, env, reloadKey]);
  return state;
}

export function useCatalogApps(apps: AppOperations, retention?: ViewRetention): { readonly state: CatalogAppsState; readonly reload: () => Promise<void> } {
  const [state, setState] = useState<CatalogAppsState>(() => retention?.catalogApps ? { ...retention.catalogApps, stale: true } : { status: "loading" });
  const generation = useRef(0);
  /** `keepShown` reloads behind the rows already on screen instead of replacing them with a loading state. */
  const load = useCallback(async (keepShown: boolean) => {
    const current = ++generation.current;
    const retained = retention?.generation;
    if (!keepShown) setState({ status: "loading" });
    try {
      const rows = await Promise.all((await apps.load()).filter(entry => entry.applicable).map(async (entry) => ({
        entry,
        inspection: await apps.inspect(entry),
      })));
      if (generation.current === current) {
        const ready = { status: "ready", rows: rows.filter(row => row.inspection.status === "not installed") } as const;
        if (retention && retention.generation === retained) retention.catalogApps = ready;
        setState(ready);
      }
    } catch (error) {
      if (generation.current === current) setState({ status: "ready", rows: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, [apps, retention]);
  const reload = useCallback(() => load(false), [load]);
  useEffect(() => {
    void load(retention?.catalogApps !== undefined);
    return () => { generation.current += 1; };
  }, [load, retention]);
  return { state, reload };
}

export interface InstalledState {
  readonly installed: InstalledSkills;
  readonly installedReady: boolean;
  /** The Skills shown come from an earlier visit and are being reloaded. */
  readonly installedStale: boolean;
  readonly reloadInstalled: () => Promise<void>;
}

/** The Skills already installed, loaded on mount and on demand. */
export function useInstalledSkills(operations: SourceOperations, env: TuiEnvironment, mounted: MutableRefObject<boolean>, retention?: ViewRetention): InstalledState {
  const [installed, setInstalled] = useState<InstalledSkills>(retention?.installed ?? NO_INSTALLED);
  const [installedReady, setInstalledReady] = useState(retention?.installed !== undefined);
  const [installedStale, setInstalledStale] = useState(retention?.installed !== undefined);
  const reloadInstalled = useCallback(async () => {
    const generation = retention?.generation;
    const loaded = await loadInstalledSkills(operations, env);
    if (retention && retention.generation === generation) retention.installed = loaded;
    if (!mounted.current) return;
    setInstalled(loaded);
    setInstalledReady(true);
    setInstalledStale(false);
  }, [operations, env, mounted, retention]);
  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);
  return { installed, installedReady, installedStale, reloadInstalled };
}

export interface CatalogFilterControls {
  readonly filter: FilterState;
  readonly filterRef: MutableRefObject<FilterState>;
  /** The query as of the latest keystroke. */
  readonly queryRef: MutableRefObject<string>;
  /** `/`: starts editing the current query. */
  readonly open: () => void;
  /** Drops the query and starts the list over through `restartList`. */
  readonly clear: (restartList: () => void) => void;
  /** Keys while the filter box is open; every change starts the list over through `restartList`. */
  readonly handleEditKey: (input: string, key: Key, restartList: () => void) => void;
}

/**
 * The filter box. Its state is mirrored in refs, updated first, so the shell
 * never sees a stale capturing state and keystrokes delivered in one burst are not lost.
 */
export function useCatalogFilter(
  actionRef: MutableRefObject<ActionMode>,
  onCapturingChange: ((capturing: boolean) => void) | undefined,
): CatalogFilterControls {
  const [filter, dispatchFilter] = useReducer(filterReducer, initialFilter);
  const filterRef = useRef<FilterState>(initialFilter);
  // The typed query, so keystrokes delivered in one burst are not lost to stale closures.
  const typed = useRef("");
  const queryRef = useRef(filter.query);
  queryRef.current = filter.query;

  const dispatch = (event: FilterEvent) => {
    filterRef.current = filterReducer(filterRef.current, event);
    onCapturingChange?.(filterRef.current.editing || actionRef.current.kind !== "browse");
    dispatchFilter(event);
  };
  const edit = (query: string, restartList: () => void) => {
    typed.current = query;
    restartList();
    dispatch({ type: "edit", query });
  };
  const clear = (restartList: () => void) => {
    typed.current = "";
    queryRef.current = "";
    restartList();
    dispatch({ type: "clear" });
  };
  const open = () => {
    typed.current = filterRef.current.query;
    dispatch({ type: "open" });
  };
  const handleEditKey = (input: string, key: Key, restartList: () => void) => {
    if (key.escape) clear(restartList);
    else if (key.return) dispatch({ type: "keep" });
    else if (key.backspace || key.delete) edit(typed.current.slice(0, -1), restartList);
    else if (input !== "" && !key.ctrl && !key.meta) edit(typed.current + input, restartList);
  };
  return { filter, filterRef, queryRef, open, clear, handleEditKey };
}
