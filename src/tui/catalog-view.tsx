import { Box, Text, type Key } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import { isValidFixedVersion } from "../skill-install.js";
import type { SourceOperations } from "../sources.js";
import { BROWSE, describeSkills, HOST_CHOICES, SCOPE_CHOICES, type ActionMode, type BatchItem } from "./catalog-actions.js";
import { filterReducer, filterSkills, initialFilter, type FilterEvent, type FilterState } from "./catalog-filter.js";
import {
  hasUnmanagedCopy,
  isInstalled,
  loadInstalledSkills,
  NO_INSTALLED,
  prepareInstall,
  runInstall,
  type InstalledSkills,
} from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { errorText, runBatch } from "./batch.js";
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
import { useKeys } from "./keys.js";

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
    children: members.map((skill): CatalogNode => ({ id: skillKey(skill), data: { kind: "skill", skill } })),
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

const UNMANAGED_MARKER = "on disk, unmanaged · adopt it from Installations";

const skillKey = (skill: SkillCandidate): string => `skill:${skill.sourceId}:${skill.path}`;

/** The Skills under the tree's Sources, in display order. */
function leavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return roots.flatMap((root) => (root.children ?? []).flatMap((child) => child.data.kind === "skill" ? [child.data.skill] : []));
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
  // Skills marked for a batch install, by node id. The ref is updated first so keys in one burst see every mark.
  const [markedState, setMarkedState] = useState<ReadonlySet<string>>(new Set());
  const markedRef = useRef<ReadonlySet<string>>(new Set());
  const setMarked = (next: ReadonlySet<string>) => {
    markedRef.current = next;
    setMarkedState(next);
  };
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
    skills: readonly SkillCandidate[],
    choice: Parameters<typeof prepareInstall>[3],
  ) => {
    setAction({ kind: "busy", label: `Refreshing source and preparing install of ${describeSkills(skills)}...` });
    const items: BatchItem[] = [];
    for (const skill of skills) {
      try {
        items.push({ skill, prepared: await prepareInstall(operations, env, skill, choice) });
      } catch (error) {
        items.push({ skill, error: errorText(error) });
      }
    }
    if (!mounted.current) return;
    if (items.every((item) => item.prepared === undefined)) {
      const text = items.length === 1 ? items[0]!.error! : items.map((item) => `Failed ${item.skill.name}: ${item.error}`).join("\n");
      setMessage({ kind: "error", text });
      setAction(BROWSE);
      return;
    }
    setAction({ kind: "confirm-install", items });
  };

  /** Reloads the installed set first so the result and the vanished Skills appear together. */
  const finish = async (result: Message) => {
    await reloadInstalled();
    if (!mounted.current) return;
    setMessage(result);
    setAction(BROWSE);
  };

  /** Applies the prepared items one by one; a failure is reported for that item and the rest still run. */
  const confirmInstall = async (items: readonly BatchItem[], exposure: boolean) => {
    setAction({ kind: "busy", label: `Installing ${describeSkills(items.map((item) => item.skill))}...` });
    const outcomes = await runBatch(items, async ({ prepared, error }) => {
      if (prepared === undefined) throw new Error(error);
      return (await runInstall(prepared, operations, exposure && prepared.additionalHostExposure)).join(" ");
    }, ({ skill }, caught) => `Failed ${skill.name}: ${errorText(caught)}`);
    const lines = outcomes.map((outcome) => outcome.line);
    const failed = new Set(outcomes.filter((outcome) => !outcome.ok).map((outcome) => skillKey(outcome.item.skill)));
    // Installed Skills leave the list; only the failed ones stay marked for another try.
    setMarked(failed);
    await finish({ kind: failed.size > 0 ? "error" : "ok", text: lines.join("\n") });
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
          if (mode.selected.length > 0) setAction({ kind: "scope", skills: mode.skills, hosts: mode.selected });
          else setMessage({ kind: "error", text: "Select at least one host" });
        }
        return;
      }
      case "scope": {
        const scope = SCOPE_CHOICES[Number(input) - 1];
        if (key.escape) cancel("Install cancelled");
        else if (scope) setAction({ kind: "version", skills: mode.skills, hosts: mode.hosts, scope });
        return;
      }
      case "version":
        if (key.escape) cancel("Install cancelled");
        else if (input === "1") void startInstall(mode.skills, { hosts: mode.hosts, scope: mode.scope, version: { policy: "latest" } });
        else if (input === "2") setAction({ ...mode, kind: "fixed", value: "" });
        return;
      case "fixed":
        if (key.escape) cancel("Install cancelled");
        else if (key.return) {
          if (isValidFixedVersion(mode.value)) {
            void startInstall(mode.skills, { hosts: mode.hosts, scope: mode.scope, version: { policy: "fixed", version: mode.value } });
          }
        } else if (key.backspace || key.delete) setAction({ ...mode, value: mode.value.slice(0, -1) });
        else if (input !== "" && !key.ctrl && !key.meta) setAction({ ...mode, value: mode.value + input });
        return;
      case "confirm-install":
        if (input === "y") {
          if (mode.items.some((item) => item.prepared?.additionalHostExposure)) setAction({ ...mode, kind: "confirm-exposure" });
          else void confirmInstall(mode.items, false);
        } else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      case "confirm-exposure":
        if (input === "y") void confirmInstall(mode.items, true);
        else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      default:
        return;
    }
  };

  useKeys((input, key) => {
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
    else if (input === " " && row) {
      if (row.node.data.kind !== "skill") {
        setMessage({ kind: "error", text: "Mark skills, not source rows" });
        return;
      }
      setMessage(undefined);
      const next = new Set(markedRef.current);
      if (!next.delete(row.node.id)) next.add(row.node.id);
      setMarked(next);
    } else if (input === "a") {
      const leaves = leavesOf(rootsRef.current);
      if (leaves.length === 0) {
        setMessage({ kind: "error", text: "There are no skills to select" });
        return;
      }
      setMessage(undefined);
      setMarked(leaves.every((skill) => markedRef.current.has(skillKey(skill))) ? new Set() : new Set(leaves.map(skillKey)));
    } else if (input === "i" && state.status === "ready" && row) {
      // Only what is listed installs: marks on Skills hidden by the filter are ignored.
      const marked = leavesOf(rootsRef.current).filter((skill) => markedRef.current.has(skillKey(skill)));
      const chosen = marked.length > 0 ? marked : row.node.data.kind === "skill" ? [row.node.data.skill] : [];
      if (chosen.length === 0) {
        setMessage({ kind: "error", text: "Install is not available for source rows; highlight a skill or mark some with space" });
        return;
      }
      setMessage(undefined);
      setAction({ kind: "host", skills: chosen, cursor: 0, selected: [] });
    }
  });

  const scope = all || sourceId === undefined ? "all sources" : sourceId;
  if (state.status === "loading" || (state.status === "ready" && !installedReady)) return <Text>Loading skills...</Text>;
  if (state.status === "error") return <Text color={theme.error}>Error: {state.message}</Text>;
  const window = computeWindow(rows.length, index, height);
  const selectedCount = leavesOf(roots).filter((skill) => markedState.has(skillKey(skill))).length;

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
            {position === index ? "> " : "  "}{"  ".repeat(row.depth)}{isSource ? "" : markedState.has(row.node.id) ? "[x] " : "[ ] "}{describeRow(row)}
            {row.node.data.kind === "skill" && hasUnmanagedCopy(row.node.data.skill, installed)
              ? <Text color={theme.marker}>{"  "}{UNMANAGED_MARKER}</Text>
              : null}
          </Text>
        );
      })}
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
      {selectedCount > 0 ? <Text color={theme.muted}>{selectedCount} selected</Text> : null}
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
          <Text>Install {describeSkills(mode.skills)}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
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
    case "confirm-install": {
      const ready = mode.items.filter((item) => item.prepared !== undefined);
      const single = mode.items.length === 1;
      return (
        <Box flexDirection="column">
          {mode.items.map(({ skill, prepared, error }) =>
            prepared === undefined ? (
              <Text key={skillKey(skill)} color={theme.error}>Cannot install {skill.name}: {error}</Text>
            ) : (
              <Box key={skillKey(skill)} flexDirection="column">
                {single ? null : <Text color={theme.group}>{skill.name}</Text>}
                {prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
              </Box>
            ))}
          {ready.some((item) => item.prepared?.runsExternalCommand) ? <Text color={theme.warning}>This install runs an external command (see above).</Text> : null}
          <Text>Install {describeSkills(ready.map((item) => item.skill))}? y/n</Text>
        </Box>
      );
    }
    case "confirm-exposure": {
      const names = mode.items.filter((item) => item.prepared?.additionalHostExposure).map((item) => item.skill.name);
      return (
        <Text color={theme.warning}>
          {names.length === 1 ? `An identical ${names[0]} already exists` : `Identical copies of ${names.join(", ")} already exist`}; adding the missing Host location needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    }
    case "busy":
      return <Text>{mode.label}</Text>;
  }
}
