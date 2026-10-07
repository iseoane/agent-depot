import type { Key } from "ink";
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

export type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly skills: readonly SkillCandidate[]; readonly bundles: readonly BundleEntry[]; readonly activeBundles: readonly BundleDescriptor[]; readonly warnings: readonly string[]; readonly sources: readonly Source[] };

/** Discovers the Skills of one Source, or of all of them, and again whenever those inputs or `reloadKey` change. */
export function useCatalogSkills(operations: SourceOperations, sourceId: string | undefined, all: boolean, env: TuiEnvironment, reloadKey = 0): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    if (!operations.discoverSkills) {
      setState({ status: "error", message: "Discovery is not supported by the configured operations" });
      return;
    }
    setState({ status: "loading" });
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
        if (!cancelled) setState({ status: "ready", skills, bundles, activeBundles, warnings, sources });
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

export interface InstalledState {
  readonly installed: InstalledSkills;
  readonly installedReady: boolean;
  readonly reloadInstalled: () => Promise<void>;
}

/** The Skills already installed, loaded on mount and on demand. */
export function useInstalledSkills(operations: SourceOperations, env: TuiEnvironment, mounted: MutableRefObject<boolean>): InstalledState {
  const [installed, setInstalled] = useState<InstalledSkills>(NO_INSTALLED);
  const [installedReady, setInstalledReady] = useState(false);
  const reloadInstalled = useCallback(async () => {
    const loaded = await loadInstalledSkills(operations, env);
    if (!mounted.current) return;
    setInstalled(loaded);
    setInstalledReady(true);
  }, [operations, env, mounted]);
  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);
  return { installed, installedReady, reloadInstalled };
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
