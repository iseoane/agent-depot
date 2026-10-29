import { Box, Text, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createAppOperations } from "../app-flow.js";
import { AppPanel, handleAppKey, isAppMode, startAppAction } from "./app-actions.js";
import { handlePackageKey, isPackageMode } from "./package-actions.js";
import type { SourceOperations } from "../sources.js";
import type { InstalledSkills } from "./catalog-installs.js";
import { packageOperationsOf, type TuiEnvironment } from "./environment.js";
import { loadInstallations, type InstallationsData } from "./installations.js";
import { BROWSE, type InstallationsMode } from "./installations-mode.js";
import { errorText } from "./batch.js";
import { handleAdoptionKey, startAdoption, type AdoptionContext } from "./adoption-actions.js";
import { handleBrowseKey, type BrowseContext } from "./installations-browse.js";
import { handleManageKey, type ManageContext } from "./manage-actions.js";
import { ModePanel } from "./installations-panel.js";
import { TreeRowLine } from "./installations-rows.js";
import { buildTree, leavesOf, markersOf, type NodeData } from "./installations-tree.js";
import { ListFooter, Working } from "./panel-parts.js";
import { useTreeNavigation } from "./tree-navigation.js";
import { defaultExpanded } from "./tree.js";
import { theme } from "./theme.js";
import { busy } from "./working-model.js";
import { useLoadingSince, useMarks, useMounted, type ViewMessage } from "./view-state.js";
import { computeWindow, useListHeight } from "./window.js";
import { useKeys } from "./keys.js";

export interface InstallationsViewProps {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  /** Reports whether the view is capturing keys, so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Rows the tree may use; defaults to what the terminal leaves. Injectable for tests. */
  readonly listHeight?: number;
}

const NO_ENVIRONMENT: TuiEnvironment = {};

const LEGEND = "adopted: tracked in place · modified: changed on disk";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: InstallationsData };

export function InstallationsView({ operations, environment, onCapturingChange, listHeight }: InstallationsViewProps) {
  const { rows: terminalRows, columns: terminalColumns } = useWindowSize();
  const height = useListHeight(listHeight, 7);
  const env = environment ?? NO_ENVIRONMENT;
  const apps = useMemo(() => createAppOperations({ homeDirectory: env.homeDirectory, ...env.appEnvironment }), [env]);
  const packages = useMemo(() => packageOperationsOf(env), [env]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [mode, setModeState] = useState<InstallationsMode>(BROWSE);
  // Mirrors the mode synchronously so later keystrokes and the shell never see stale state.
  const modeRef = useRef<InstallationsMode>(BROWSE);
  const marks = useMarks();
  const mounted = useMounted();
  const [message, setMessage] = useState<ViewMessage | undefined>();

  const setMode = (next: InstallationsMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  };

  // Reloads and App checks can overlap, so counts decide when each indicator ends.
  const [refreshingSince, setRefreshingSince] = useState<number | undefined>();
  const reloads = useRef(0);
  const [checkingSince, setCheckingSince] = useState<number | undefined>();
  const checks = useRef(0);

  const loadGeneration = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (reloads.current++ === 0 && mounted.current) setRefreshingSince(Date.now());
    try {
      const data = await loadInstallations(operations, env, apps, packages);
      if (mounted.current && generation === loadGeneration.current) setState({ status: "ready", data });
    } catch (error) {
      if (mounted.current && generation === loadGeneration.current) setState({ status: "error", message: errorText(error) });
    } finally {
      if (--reloads.current === 0 && mounted.current) setRefreshingSince(undefined);
    }
  }, [operations, env, apps, packages, mounted]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const data = state.status === "ready" ? state.data : undefined;
  const roots = useMemo(() => (data ? buildTree(data) : []), [data]);
  const navigation = useTreeNavigation<NodeData>(roots, defaultExpanded);
  const { rows, index } = navigation;
  const checked = useRef(new Set<string>());
  const highlighted = rows[index]?.node.data;
  // The entry is kept when the tree is rebuilt with a check's result, and replaced only by a reload,
  // so the effect below does not re-run for the node objects `buildTree` makes anew.
  const highlightedEntry = highlighted?.kind === "app" ? highlighted.row.entry : undefined;
  useEffect(() => {
    if (highlightedEntry === undefined) return;
    const entry = highlightedEntry;
    const identity = `${entry.file}:${entry.hash}`;
    if (checked.current.has(identity)) return;
    checked.current.add(identity);
    const generation = loadGeneration.current;
    if (checks.current++ === 0) setCheckingSince(Date.now());
    void apps.approvalStatus(entry).then(approval => {
      if (approval.status !== "approved") return undefined;
      return apps.inspect(entry);
    }).then(inspection => {
      if (!inspection || !mounted.current || generation !== loadGeneration.current) return;
      // An unknown result is asked again only when focus returns to the App, never by the rebuilt tree.
      if (inspection.status === "unknown") checked.current.delete(identity);
      setState(previous => previous.status !== "ready" ? previous : {
        ...previous,
        data: {
          ...previous.data,
          apps: previous.data.apps?.map(row => row.entry.file === entry.file && row.entry.hash === entry.hash
            ? { entry, inspection } : row),
        },
      });
    }).catch(error => {
      if (!mounted.current || generation !== loadGeneration.current) return;
      checked.current.delete(identity);
      setMessage({ kind: "error", text: errorText(error) });
    }).finally(() => {
      if (--checks.current === 0 && mounted.current) setCheckingSince(undefined);
    });
  }, [highlightedEntry, apps, mounted]);

  const installed = useMemo<InstalledSkills>(
    () => ({
      global: (data?.global ?? []).map((row) => row.selection),
      project: (data?.project ?? []).map((row) => row.selection),
      sources: data?.sources ?? [],
      unmanagedNames: new Set<string>(),
    }),
    [data],
  );

  const loadingSince = useLoadingSince(state.status === "loading");
  /** Reloads after an action: the busy panel, which keeps the action's clock, says what is now running. */
  const refresh = async () => {
    const current = modeRef.current;
    if ("startedAt" in current && mounted.current) setMode(busy("Refreshing installations…", current));
    await reload();
  };
  const manage: ManageContext = {
    operations,
    env,
    installed,
    setMode,
    browse: () => setMode(BROWSE),
    setMessage,
    isMounted: () => mounted.current,
    unmark: (ids) => marks.setMarked(new Set([...marks.markedRef.current].filter((id) => !ids.includes(id)))),
    finish: async (result) => {
      checked.current.clear();
      await refresh();
      if (!mounted.current) return;
      setMessage(result);
      setMode(BROWSE);
    },
  };

  const adoption: AdoptionContext = {
    operations,
    env,
    setMode,
    browse: manage.browse,
    setMessage,
    isMounted: manage.isMounted,
    reload: refresh,
  };

  const browse: BrowseContext = {
    navigation,
    height,
    marks,
    data,
    manage,
    packages,
    startAdoption: (group) => void startAdoption(adoption, group),
    setMessage,
    startApps: (entries, input) => void startAppAction({ apps, manage, terminalRows: terminalRows || 24, terminalColumns: terminalColumns || 80 }, entries, input),
  };

  useKeys((input, key) => {
    const current = modeRef.current;
    if (current.kind === "browse") handleBrowseKey(browse, input, key);
    else if (isPackageMode(current)) handlePackageKey({ packages, manage }, current, input, key);
    else if (isAppMode(current)) handleAppKey({ apps, manage, terminalRows: terminalRows || 24, terminalColumns: terminalColumns || 80 }, current, input, key);
    else if (!handleManageKey(manage, current, input, key)) handleAdoptionKey(adoption, current, input, key);
  });

  if (state.status === "loading") return <Working label="Loading installations…" since={loadingSince} />;
  if (state.status === "error") return <Text color={theme.error}>Error: {state.message}</Text>;
  if (isAppMode(mode)) return <AppPanel mode={mode} />;
  const ready = state.data;
  const window = computeWindow(rows.length, index, height);
  const listed = rows.slice(window.start, window.end);
  const markedLeaves = leavesOf(roots).filter(node => marks.marked.has(node.id));
  const selectedCount = markedLeaves.length;
  const markedApps = markedLeaves.filter(node => node.data.kind === "app").length;
  // The legend explains the markers, so it shows only while a rendered row carries one.
  const legendNeeded = listed.some((row) => row.node.data.kind === "installation" && markersOf(row.node.data.row) !== "");

  return (
    <Box flexDirection="column">
      {/* While an action runs its own busy panel is the one indicator. */}
      {refreshingSince !== undefined && mode.kind === "browse" ? <Working label="Refreshing installations…" since={refreshingSince} /> : null}
      {ready.global === undefined ? <Text>User-global installations are not supported by the configured operations</Text> : null}
      {ready.projectError === undefined ? null : <Text color={theme.error}>Error: {ready.projectError}</Text>}
      {listed.map((row, offset) => (
        <TreeRowLine key={row.node.id} row={row} selected={window.start + offset === index} marked={marks.marked.has(row.node.id)} />
      ))}
      <ListFooter indicator={window.indicator} selectedCount={selectedCount} message={message} />
      {markedApps > 0 ? <Text color={theme.muted}>{markedApps} Apps marked</Text> : null}
      {legendNeeded ? <Text color={theme.muted}>{LEGEND}</Text> : null}
      {checkingSince !== undefined && refreshingSince === undefined && mode.kind === "browse"
        ? <Working label="Checking App status…" since={checkingSince} /> : null}
      <ModePanel mode={mode} />
    </Box>
  );
}
