import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SourceOperations } from "../sources.js";
import { BROWSE, type ActionMode } from "./catalog-actions.js";
import { handleCatalogBrowseKey, type CatalogBrowseContext } from "./catalog-browse.js";
import { filterSkills } from "./catalog-filter.js";
import { handleCatalogActionKey, type CatalogFlowContext } from "./catalog-flow.js";
import { isInstalled } from "./catalog-installs.js";
import { ActionPanel, CatalogHeader, CatalogRowLine } from "./catalog-panel.js";
import { ListFooter } from "./panel-parts.js";
import { useCatalogFilter, useCatalogSkills, useInstalledSkills } from "./catalog-state.js";
import { buildTree, leavesOf, openByDefault, skillKey, type NodeData } from "./catalog-tree.js";
import type { TuiEnvironment } from "./environment.js";
import { theme } from "./theme.js";
import { useTreeNavigation } from "./tree-navigation.js";
import { useMarks, useMounted, type ViewMessage } from "./view-state.js";
import { computeWindow, useListHeight } from "./window.js";
import { useKeys } from "./keys.js";

const NO_ENVIRONMENT: TuiEnvironment = {};

export interface CatalogViewProps {
  readonly operations: SourceOperations;
  /** Source whose skills are listed; when absent the catalog covers all sources. */
  readonly sourceId?: string;
  /** Reports whether the view is capturing keys (filter input), so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Where installs happen; defaults to the real home and working directory. */
  readonly environment?: TuiEnvironment;
  /** Rows the list may use; defaults to what the terminal leaves. Injectable for tests. */
  readonly listHeight?: number;
}

export function CatalogView({ operations, sourceId, onCapturingChange, environment, listHeight }: CatalogViewProps) {
  const height = useListHeight(listHeight, 6);
  const env = environment ?? NO_ENVIRONMENT;
  const [all, setAll] = useState(sourceId === undefined);
  const mounted = useMounted();
  const marks = useMarks();
  const [message, setMessage] = useState<ViewMessage | undefined>();
  const [action, setActionState] = useState<ActionMode>(BROWSE);
  // Mirrors the action mode synchronously, like the filter, so later keystrokes and the shell never see stale state.
  const actionRef = useRef<ActionMode>(BROWSE);
  const filter = useCatalogFilter(actionRef, onCapturingChange);
  const state = useCatalogSkills(operations, sourceId, all);
  const { installed, installedReady, reloadInstalled } = useInstalledSkills(operations, env, mounted);

  const setAction = (next: ActionMode) => {
    actionRef.current = next;
    onCapturingChange?.(filter.filterRef.current.editing || next.kind !== "browse");
    setActionState(next);
  };

  const skills = state.status === "ready" ? state.skills : [];
  const installable = useMemo(() => skills.filter((skill) => !isInstalled(skill, installed)), [state, installed]);
  const visible = useMemo(() => filterSkills(installable, filter.filter.query), [installable, filter.filter.query]);
  const roots = useMemo(() => buildTree(visible, state.status === "ready" ? state.sources : []), [visible, state]);
  const navigation = useTreeNavigation<NodeData>(roots, (nodes) => openByDefault(nodes, filter.queryRef.current));
  // Discovering again starts the list over.
  const { restart } = navigation;
  useEffect(restart, [operations, sourceId, all, restart]);
  const { rows, index } = navigation;

  const flow: CatalogFlowContext = {
    operations,
    env,
    setAction,
    setMessage,
    isMounted: () => mounted.current,
    keepMarked: marks.setMarked,
    finish: async (result) => {
      await reloadInstalled();
      if (!mounted.current) return;
      setMessage(result);
      setAction(BROWSE);
    },
  };
  const browse: CatalogBrowseContext = {
    navigation,
    height,
    marks,
    filter,
    canWiden: sourceId !== undefined,
    ready: state.status === "ready",
    toggleAll: () => setAll((value) => !value),
    setMessage,
    setAction,
  };

  useKeys((input, key) => {
    const mode = actionRef.current;
    if (mode.kind !== "browse") handleCatalogActionKey(flow, mode, input, key);
    else if (filter.filterRef.current.editing) filter.handleEditKey(input, key, navigation.restart);
    else handleCatalogBrowseKey(browse, input, key);
  });

  const scope = all || sourceId === undefined ? "all sources" : sourceId;
  if (state.status === "loading" || (state.status === "ready" && !installedReady)) return <Text>Loading skills...</Text>;
  if (state.status === "error") return <Text color={theme.error}>Error: {state.message}</Text>;
  const window = computeWindow(rows.length, index, height);
  const selectedCount = leavesOf(roots).filter((skill) => marks.marked.has(skillKey(skill))).length;

  return (
    <Box flexDirection="column">
      {state.warnings.map((warning) => <Text key={warning} color={theme.warning}>{warning}</Text>)}
      <CatalogHeader scope={scope} listed={visible.length} installable={installable.length} total={skills.length} filter={filter.filter} />
      {rows.slice(window.start, window.end).map((row, offset) => (
        <CatalogRowLine key={row.node.id} row={row} selected={window.start + offset === index} marked={marks.marked.has(row.node.id)} installed={installed} />
      ))}
      <ListFooter indicator={window.indicator} selectedCount={selectedCount} message={message} />
      <ActionPanel mode={action} />
    </Box>
  );
}
