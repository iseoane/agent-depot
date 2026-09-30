import { Box, Text, useInput, type Key } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import { isValidFixedVersion } from "../skill-install.js";
import type { SourceOperations } from "../sources.js";
import { BROWSE, HOST_CHOICES, SCOPE_CHOICES, type ActionMode } from "./catalog-actions.js";
import { filterReducer, filterSkills, initialFilter, type FilterEvent, type FilterState } from "./catalog-filter.js";
import {
  isInstalled,
  loadInstalledSkills,
  NO_INSTALLED,
  prepareInstall,
  runInstall,
  type InstalledSkills,
} from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { errorText } from "./manage-actions.js";
import { rowStyle, theme } from "./theme.js";
import {
  collapseOrParent,
  defaultExpanded,
  expandNode,
  flattenVisible,
  resolveSelection,
  toggleNode,
  type Expanded,
  type TreeNode,
  type VisibleRow,
} from "./tree.js";
import { computeWindow, pageStep, useListHeight } from "./window.js";

const DESCRIPTION_LIMIT = 60;
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

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly skills: readonly SkillCandidate[] };

/** A source group or an installable Skill. */
type NodeData =
  | { readonly kind: "source"; readonly sourceId: string; readonly count: number }
  | { readonly kind: "skill"; readonly skill: SkillCandidate };

type CatalogNode = TreeNode<NodeData>;
type Selection = { readonly id?: string; readonly index: number };

function truncate(text: string): string {
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 3)}...` : text;
}

/** Skills grouped by Source in first-seen order; a Source with no Skills never appears. */
function buildTree(skills: readonly SkillCandidate[]): readonly CatalogNode[] {
  const bySource = new Map<string, SkillCandidate[]>();
  for (const skill of skills) bySource.set(skill.sourceId, [...(bySource.get(skill.sourceId) ?? []), skill]);
  return [...bySource].map(([sourceId, members]): CatalogNode => ({
    id: `source:${sourceId}`,
    data: { kind: "source", sourceId, count: members.length },
    children: members.map((skill): CatalogNode => ({ id: `skill:${skill.sourceId}:${skill.path}`, data: { kind: "skill", skill } })),
  }));
}

function allSourceIds(roots: readonly CatalogNode[]): Expanded {
  return new Set(roots.filter((root) => (root.children?.length ?? 0) > 0).map((root) => root.id));
}

function describeRow(row: VisibleRow<NodeData>): string {
  const { data } = row.node;
  if (data.kind === "source") return `${row.expanded ? "▾" : "▸"} ${data.sourceId} (${data.count})`;
  return `${data.skill.name}  ${truncate(data.skill.description)}`;
}

export function CatalogView({ operations, sourceId, onCapturingChange, environment, listHeight }: CatalogViewProps) {
  const height = useListHeight(listHeight, 6);
  const [all, setAll] = useState(sourceId === undefined);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Expansion and selection are mirrored in refs so keys delivered in one burst act on the latest state.
  const [expandedState, setExpandedState] = useState<Expanded | undefined>();
  const expandedRef = useRef<Expanded | undefined>(undefined);
  const [selection, setSelectionState] = useState<Selection>({ index: 0 });
  const selectionRef = useRef<Selection>({ index: 0 });
  const [filter, dispatchFilter] = useReducer(filterReducer, initialFilter);
  // Mirrors the filter synchronously so the shell never sees a stale capturing state.
  const filterRef = useRef<FilterState>(initialFilter);
  // Mirrors the typed query synchronously so keystrokes delivered in one burst are not lost to stale closures.
  const typed = useRef("");
  const [installed, setInstalled] = useState<InstalledSkills>(NO_INSTALLED);
  const [installedReady, setInstalledReady] = useState(false);
  const [action, setActionState] = useState<ActionMode>(BROWSE);
  // Mirrors the action mode synchronously, like the filter, so later keystrokes and the shell never see stale state.
  const actionRef = useRef<ActionMode>(BROWSE);
  const mounted = useRef(true);
  const [message, setMessage] = useState<Message | undefined>();
  const env = environment ?? NO_ENVIRONMENT;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reloadInstalled = useCallback(async () => {
    const loaded = await loadInstalledSkills(operations, env);
    if (!mounted.current) return;
    setInstalled(loaded);
    setInstalledReady(true);
  }, [operations, env]);

  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

  const setAction = (next: ActionMode) => {
    actionRef.current = next;
    onCapturingChange?.(filterRef.current.editing || next.kind !== "browse");
    setActionState(next);
  };

  const setSelection = (next: Selection) => {
    selectionRef.current = next;
    setSelectionState(next);
  };
  const setExpanded = (next: Expanded | undefined) => {
    expandedRef.current = next;
    setExpandedState(next);
  };

  useEffect(() => {
    let cancelled = false;
    if (!operations.discoverSkills) {
      setState({ status: "error", message: "Discovery is not supported by the configured operations" });
      return;
    }
    setState({ status: "loading" });
    setSelection({ index: 0 });
    setExpanded(undefined);
    void (async () => {
      try {
        const ids = all || sourceId === undefined
          ? (await operations.listSources()).map((source) => source.id)
          : [sourceId];
        const skills = await operations.discoverSkills!(ids);
        if (!cancelled) setState({ status: "ready", skills });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [operations, sourceId, all]);

  const dispatch = (event: FilterEvent) => {
    filterRef.current = filterReducer(filterRef.current, event);
    onCapturingChange?.(filterRef.current.editing || actionRef.current.kind !== "browse");
    dispatchFilter(event);
  };

  const skills = state.status === "ready" ? state.skills : [];
  const installable = useMemo(() => skills.filter((skill) => !isInstalled(skill, installed)), [state, installed]);
  const visible = useMemo(() => filterSkills(installable, filter.query), [installable, filter.query]);
  const roots = useMemo(() => buildTree(visible), [visible]);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const queryRef = useRef(filter.query);
  queryRef.current = filter.query;
  /** While a filter is set every matching source is open so the matches show; otherwise only the first. */
  const openByDefault = (nodes: readonly CatalogNode[], query: string) =>
    query === "" ? defaultExpanded(nodes) : allSourceIds(nodes);
  const expanded = expandedState ?? openByDefault(roots, filter.query);
  const rows = flattenVisible(roots, expanded);
  const index = resolveSelection(rows, selection);

  /** Visible rows and the selected index as of the latest keystroke. */
  const latest = () => {
    const open = expandedRef.current ?? openByDefault(rootsRef.current, queryRef.current);
    const visibleRows = flattenVisible(rootsRef.current, open);
    return { open, visibleRows, at: resolveSelection(visibleRows, selectionRef.current) };
  };
  const moveTo = (visibleRows: readonly VisibleRow<NodeData>[], target: number) => {
    const bounded = Math.min(Math.max(target, 0), Math.max(visibleRows.length - 1, 0));
    setSelection({ id: visibleRows[bounded]?.node.id, index: bounded });
  };
  /** A changed filter starts over: top of the list, sources opened by the default rule. */
  const restartList = () => {
    setSelection({ index: 0 });
    setExpanded(undefined);
  };

  const startInstall = async (
    skill: SkillCandidate,
    choice: Parameters<typeof prepareInstall>[3],
  ) => {
    setAction({ kind: "busy", label: `Refreshing source and preparing install of ${skill.name}...` });
    try {
      const prepared = await prepareInstall(operations, env, skill, choice);
      if (!mounted.current) return;
      setAction({ kind: "confirm-install", skill, prepared });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", text: errorText(error) });
      setAction(BROWSE);
    }
  };

  /** Reloads the installed set first so the result and the vanished Skill appear together. */
  const finish = async (result: Message) => {
    await reloadInstalled();
    if (!mounted.current) return;
    setMessage(result);
    setAction(BROWSE);
  };

  const confirmInstall = async (mode: Extract<ActionMode, { kind: "confirm-install" | "confirm-exposure" }>, exposure: boolean) => {
    setAction({ kind: "busy", label: `Installing ${mode.skill.name}...` });
    let result: Message;
    try {
      result = { kind: "ok", text: (await runInstall(mode.prepared, operations, exposure)).join(" ") };
    } catch (error) {
      result = { kind: "error", text: errorText(error) };
    }
    await finish(result);
  };

  const cancel = (text: string) => {
    setMessage({ kind: "ok", text });
    setAction(BROWSE);
  };

  const handleActionKey = (mode: ActionMode, input: string, key: Key) => {
    switch (mode.kind) {
      case "host": {
        const toggle = (host: ProjectHost) =>
          HOST_CHOICES.filter((candidate) => candidate === host ? !mode.selected.includes(candidate) : mode.selected.includes(candidate));
        if (key.escape) cancel("Install cancelled");
        else if (key.downArrow || input === "j") setAction({ ...mode, cursor: Math.min(mode.cursor + 1, HOST_CHOICES.length - 1) });
        else if (key.upArrow || input === "k") setAction({ ...mode, cursor: Math.max(mode.cursor - 1, 0) });
        else if (input === " ") setAction({ ...mode, selected: toggle(HOST_CHOICES[mode.cursor]!) });
        else if (HOST_CHOICES[Number(input) - 1]) setAction({ ...mode, selected: toggle(HOST_CHOICES[Number(input) - 1]!) });
        else if (key.return) {
          if (mode.selected.length > 0) setAction({ kind: "scope", skill: mode.skill, hosts: mode.selected });
          else setMessage({ kind: "error", text: "Select at least one host" });
        }
        return;
      }
      case "scope": {
        const scope = SCOPE_CHOICES[Number(input) - 1];
        if (key.escape) cancel("Install cancelled");
        else if (scope) setAction({ kind: "version", skill: mode.skill, hosts: mode.hosts, scope });
        return;
      }
      case "version":
        if (key.escape) cancel("Install cancelled");
        else if (input === "1") void startInstall(mode.skill, { hosts: mode.hosts, scope: mode.scope, version: { policy: "latest" } });
        else if (input === "2") setAction({ ...mode, kind: "fixed", value: "" });
        return;
      case "fixed":
        if (key.escape) cancel("Install cancelled");
        else if (key.return) {
          if (isValidFixedVersion(mode.value)) {
            void startInstall(mode.skill, { hosts: mode.hosts, scope: mode.scope, version: { policy: "fixed", version: mode.value } });
          }
        } else if (key.backspace || key.delete) setAction({ ...mode, value: mode.value.slice(0, -1) });
        else if (input !== "" && !key.ctrl && !key.meta) setAction({ ...mode, value: mode.value + input });
        return;
      case "confirm-install":
        if (input === "y") {
          if (mode.prepared.additionalHostExposure) setAction({ ...mode, kind: "confirm-exposure" });
          else void confirmInstall(mode, false);
        } else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      case "confirm-exposure":
        if (input === "y") void confirmInstall(mode, true);
        else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      default:
        return;
    }
  };

  useInput((input, key) => {
    const mode = actionRef.current;
    if (mode.kind !== "browse") {
      handleActionKey(mode, input, key);
      return;
    }
    const current = filterRef.current;
    if (current.editing) {
      if (key.escape) {
        typed.current = "";
        queryRef.current = "";
        restartList();
        dispatch({ type: "clear" });
      } else if (key.return) dispatch({ type: "keep" });
      else if (key.backspace || key.delete) {
        typed.current = typed.current.slice(0, -1);
        restartList();
        dispatch({ type: "edit", query: typed.current });
      } else if (input !== "" && !key.ctrl && !key.meta) {
        typed.current += input;
        restartList();
        dispatch({ type: "edit", query: typed.current });
      }
      return;
    }
    const { open, visibleRows, at } = latest();
    const row = visibleRows[at];
    if (key.downArrow || input === "j") moveTo(visibleRows, at + 1);
    else if (key.upArrow || input === "k") moveTo(visibleRows, at - 1);
    else if (key.pageDown) moveTo(visibleRows, at + pageStep(height));
    else if (key.pageUp) moveTo(visibleRows, at - pageStep(height));
    else if (key.rightArrow && row) setExpanded(expandNode(open, row));
    else if (key.leftArrow && row) {
      const next = collapseOrParent(open, visibleRows, at);
      setExpanded(next.expanded);
      setSelection({ id: next.selectedId, index: at });
    } else if (key.return && row) setExpanded(toggleNode(open, row));
    else if (input === "/") {
      typed.current = current.query;
      dispatch({ type: "open" });
    } else if (key.escape && current.query !== "") {
      typed.current = "";
      queryRef.current = "";
      restartList();
      dispatch({ type: "clear" });
    } else if (input === "s" && sourceId !== undefined) setAll((value) => !value);
    else if (input === "i" && state.status === "ready" && row?.node.data.kind === "skill") {
      setMessage(undefined);
      setAction({ kind: "host", skill: row.node.data.skill, cursor: 0, selected: [] });
    }
  });

  const scope = all || sourceId === undefined ? "all sources" : sourceId;
  if (state.status === "loading" || (state.status === "ready" && !installedReady)) return <Text>Loading skills...</Text>;
  if (state.status === "error") return <Text color={theme.error}>Error: {state.message}</Text>;
  const window = computeWindow(rows.length, index, height);

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>
        Scope: {scope}  {visible.length} of {installable.length}
      </Text>
      {filter.editing || filter.query !== "" ? (
        <Text>Filter: {filter.query}{filter.editing ? "_" : ""}</Text>
      ) : null}
      {skills.length === 0 ? <Text>No skills</Text> : null}
      {skills.length > 0 && installable.length === 0 ? <Text>All skills are installed</Text> : null}
      {installable.length > 0 && visible.length === 0 ? <Text>No matching skills</Text> : null}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const position = window.start + offset;
        const isSource = row.node.data.kind === "source";
        return (
          <Text key={row.node.id} {...rowStyle(position === index)} color={isSource ? theme.group : undefined}>
            {position === index ? "> " : "  "}{"  ".repeat(row.depth)}{isSource ? "" : "  "}{describeRow(row)}
          </Text>
        );
      })}
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
      {message ? <Text color={message.kind === "error" ? theme.error : theme.success}>{message.text}</Text> : null}
      <ActionPanel mode={action} />
    </Box>
  );
}

function ActionPanel({ mode }: { readonly mode: ActionMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Install {mode.skill.name}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          {HOST_CHOICES.map((host, position) => (
            <Text key={host}>
              {position === mode.cursor ? "> " : "  "}[{mode.selected.includes(host) ? "x" : " "}] {position + 1} {host}
            </Text>
          ))}
        </Box>
      );
    case "scope":
      return <Text>Scope: {SCOPE_CHOICES.map((scope, i) => `${i + 1} ${scope}`).join("  ")}  (Esc cancel)</Text>;
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "confirm-install":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          {mode.prepared.runsExternalCommand ? <Text color={theme.warning}>This install runs an external command (see above).</Text> : null}
          <Text>Install {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "confirm-exposure":
      return (
        <Text color={theme.warning}>
          An identical {mode.skill.name} already exists; adding the missing Host location needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    case "busy":
      return <Text>{mode.label}</Text>;
  }
}
