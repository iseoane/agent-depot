import { Box, Text, useInput, type Key } from "ink";
import path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import { isValidFixedVersion } from "../skill-install.js";
import type { SourceOperations } from "../sources.js";
import { HOST_CHOICES } from "./catalog-actions.js";
import { runInstall, type InstalledSkills } from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import {
  defaultAdoptionHosts,
  findAdoptionCandidates,
  loadInstallations,
  prepareAdoption,
  sourceIdOf,
  type InstallationRow,
  type InstallationsData,
  type UnmanagedGroup,
} from "./installations.js";
import { BROWSE, type InstallationsMode } from "./installations-mode.js";
import { errorText, handleManageKey, startHostAddition, startUninstall, type ManageContext } from "./manage-actions.js";
import { ManagePanel } from "./manage-panel.js";
import { startUnmanagedRemoval } from "./unmanaged-actions.js";
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
import { rowStyle, theme } from "./theme.js";
import { computeWindow, pageStep, useListHeight } from "./window.js";

export interface InstallationsViewProps {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  /** Reports whether the view is capturing keys, so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Rows the tree may use; defaults to what the terminal leaves. Injectable for tests. */
  readonly listHeight?: number;
}

const NO_ENVIRONMENT: TuiEnvironment = {};

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: InstallationsData };

/** What a tree node stands for: a scope or source group, a managed installation or an unmanaged Skill. */
type NodeData =
  | { readonly kind: "group"; readonly label: string }
  | { readonly kind: "installation"; readonly row: InstallationRow }
  | { readonly kind: "unmanaged"; readonly group: UnmanagedGroup };

type InstallationNode = TreeNode<NodeData>;

/** Managed installations of one scope, grouped by Source in first-seen order. */
function sourceNodes(scope: InstallationRow["scope"], rows: readonly InstallationRow[]): readonly InstallationNode[] {
  const bySource = new Map<string, InstallationRow[]>();
  for (const row of rows) bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
  return [...bySource].map(([source, members]): InstallationNode => ({
    id: `source:${scope}:${source}`,
    data: { kind: "group", label: `${source} (${members.length})` },
    children: members.map((row): InstallationNode => ({
      id: `installation:${scope}:${source}:${row.selection.installation?.path ?? row.selection.path}`,
      data: { kind: "installation", row },
    })),
  }));
}

/** Scope, then Source, then Skills; Unmanaged is its own group. Counts come from data already loaded. */
function buildTree(data: InstallationsData): readonly InstallationNode[] {
  const roots: InstallationNode[] = [];
  if (data.global !== undefined) {
    roots.push({
      id: "scope:user-global",
      data: { kind: "group", label: `Managed (user-global) (${data.global.length})` },
      children: sourceNodes("user-global", data.global),
    });
  }
  roots.push({
    id: "scope:project",
    data: { kind: "group", label: `Managed (project) (${data.project.length})` },
    children: sourceNodes("project", data.project),
  });
  roots.push({
    id: "scope:unmanaged",
    data: { kind: "group", label: `Unmanaged (user-global) (${data.unmanaged.length})` },
    children: data.unmanaged.map((group): InstallationNode => ({ id: `unmanaged:${group.name}`, data: { kind: "unmanaged", group } })),
  });
  return roots;
}

/** Version, policy and hosts of a leaf; `adopted` / `modified` only when true (the legend explains them). */
function describeDetails({ selection, policy, installed }: InstallationRow): string {
  return `${installed} (${policy})  [${selection.hosts.join(", ")}]`;
}

function markersOf({ adopted, modified }: InstallationRow): string {
  return [adopted ? "adopted" : "", modified ? "modified" : ""].filter((flag) => flag !== "").join(" ");
}

/** Why a key does nothing on a group row. */
const GROUP_ROW_MESSAGE: Record<"A" | "u" | "h" | "i", string> = {
  A: "Adoption is not available for group rows",
  u: "Uninstall is not available for group rows",
  h: "Host changes are not available for group rows",
  i: "Host changes are not available for group rows",
};

const LEGEND = "adopted = tracked in place, not copied by agent-depot · modified = changed on disk";

/** The Skill of an installation, as the shared manage flows expect it. */
function skillOf(row: InstallationRow, sourceId: string): SkillCandidate {
  return { sourceId, path: row.selection.path, name: path.posix.basename(row.selection.path), description: "" };
}

function describeNode(row: VisibleRow<NodeData>): string {
  const { data } = row.node;
  if (data.kind === "group") return `${row.expandable ? (row.expanded ? "▾" : "▸") : " "} ${data.label}`;
  if (data.kind === "installation") return data.row.selection.path;
  return `${data.group.name} [${data.group.hosts.join(", ")}]`;
}

/** `symlink → <target>` for the locations that are links, one entry per distinct target. */
function describeLinks(group: UnmanagedGroup): string {
  const targets = [...new Set(group.locations.flatMap((location) => location.linkTarget === undefined ? [] : [location.linkTarget]))];
  return targets.length === 0 ? "" : `symlink → ${targets.join(", ")}`;
}

export function InstallationsView({ operations, environment, onCapturingChange, listHeight }: InstallationsViewProps) {
  const height = useListHeight(listHeight, 7);
  const env = environment ?? NO_ENVIRONMENT;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Expansion and selection are mirrored in refs so keys delivered in one burst act on the latest state.
  const [expandedState, setExpandedState] = useState<Expanded | undefined>();
  const expandedRef = useRef<Expanded | undefined>(undefined);
  const [selection, setSelectionState] = useState<{ readonly id?: string; readonly index: number }>({ index: 0 });
  const selectionRef = useRef<{ readonly id?: string; readonly index: number }>({ index: 0 });
  const [mode, setModeState] = useState<InstallationsMode>(BROWSE);
  // Mirrors the mode synchronously so later keystrokes and the shell never see stale state.
  const modeRef = useRef<InstallationsMode>(BROWSE);
  const mounted = useRef(true);
  const [message, setMessage] = useState<Message | undefined>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setMode = (next: InstallationsMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  };

  const reload = useCallback(async () => {
    try {
      const data = await loadInstallations(operations, env);
      if (mounted.current) setState({ status: "ready", data });
    } catch (error) {
      if (mounted.current) setState({ status: "error", message: errorText(error) });
    }
  }, [operations, env]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const data = state.status === "ready" ? state.data : undefined;
  const roots = useMemo(() => (data ? buildTree(data) : []), [data]);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const expanded = expandedState ?? defaultExpanded(roots);
  const rows = flattenVisible(roots, expanded);
  const index = resolveSelection(rows, selection);

  const setExpanded = (next: Expanded) => {
    expandedRef.current = next;
    setExpandedState(next);
  };
  const setSelection = (next: { readonly id?: string; readonly index: number }) => {
    selectionRef.current = next;
    setSelectionState(next);
  };
  /** Visible rows and the selected index as of the latest keystroke. */
  const latest = () => {
    const open = expandedRef.current ?? defaultExpanded(rootsRef.current);
    const visible = flattenVisible(rootsRef.current, open);
    return { open, visible, at: resolveSelection(visible, selectionRef.current) };
  };
  const moveTo = (visible: readonly VisibleRow<NodeData>[], target: number) => {
    const bounded = Math.min(Math.max(target, 0), Math.max(visible.length - 1, 0));
    setSelection({ id: visible[bounded]?.node.id, index: bounded });
  };

  const cancel = (text: string) => {
    setMessage({ kind: "ok", text });
    setMode(BROWSE);
  };

  const fail = (error: unknown) => {
    if (!mounted.current) return;
    setMessage({ kind: "error", text: errorText(error) });
    setMode(BROWSE);
  };

  const installed = useMemo<InstalledSkills>(
    () => ({
      global: (data?.global ?? []).map((row) => row.selection),
      project: (data?.project ?? []).map((row) => row.selection),
      sources: data?.sources ?? [],
    }),
    [data],
  );

  const manage: ManageContext = {
    operations,
    env,
    installed,
    setMode,
    browse: () => setMode(BROWSE),
    setMessage,
    isMounted: () => mounted.current,
    finish: async (result) => {
      await reload();
      if (!mounted.current) return;
      setMessage(result);
      setMode(BROWSE);
    },
  };

  const startAdoption = async (group: UnmanagedGroup) => {
    // Adoption keeps an existing directory in place, so it needs a real directory (the shared root first).
    const entry = group.locations.find((location) => location.entry !== undefined)?.entry;
    if (entry === undefined) {
      setMessage({ kind: "error", text: "Adoption is not available for symlinks" });
      return;
    }
    setMessage(undefined);
    setMode({ kind: "busy", label: `Looking for a Source Skill named ${entry.name}...` });
    try {
      const candidates = await findAdoptionCandidates(operations, entry);
      if (!mounted.current) return;
      if (candidates.length === 0) {
        setMessage({ kind: "error", text: `No Source Skill named "${entry.name}" exists in the registered Sources, so ${entry.path} cannot be adopted` });
        setMode(BROWSE);
      } else if (candidates.length === 1) {
        setMode({ kind: "host", entry, skill: candidates[0]!, cursor: 0, selected: defaultAdoptionHosts(entry) });
      } else {
        setMode({ kind: "pick", entry, candidates, cursor: 0 });
      }
    } catch (error) {
      fail(error);
    }
  };

  const prepare = async (
    mode: Extract<InstallationsMode, { kind: "version" | "fixed" }>,
    version: Parameters<typeof prepareAdoption>[4]["version"],
  ) => {
    setMode({ kind: "busy", label: `Refreshing source and checking that ${mode.entry.name} matches...` });
    try {
      const adoption = await prepareAdoption(operations, env, mode.entry, mode.skill, { hosts: mode.hosts, version });
      if (!mounted.current) return;
      setMode({ kind: "confirm", entry: mode.entry, skill: mode.skill, adoption });
    } catch (error) {
      fail(error);
    }
  };

  const confirm = async (mode: Extract<InstallationsMode, { kind: "confirm" | "confirm-exposure" }>, exposure: boolean) => {
    setMode({ kind: "busy", label: `Adopting ${mode.entry.name}...` });
    let result: Message;
    try {
      result = { kind: "ok", text: (await runInstall(mode.adoption.prepared, operations, exposure)).join(" ") };
    } catch (error) {
      result = { kind: "error", text: errorText(error) };
    }
    await reload();
    if (!mounted.current) return;
    setMessage(result);
    setMode(BROWSE);
  };

  const handleModeKey = (current: InstallationsMode, input: string, key: Key) => {
    if (handleManageKey(manage, current, input, key)) return;
    switch (current.kind) {
      case "pick":
        if (key.escape) cancel("Adoption cancelled");
        else if (key.downArrow || input === "j") setMode({ ...current, cursor: Math.min(current.cursor + 1, current.candidates.length - 1) });
        else if (key.upArrow || input === "k") setMode({ ...current, cursor: Math.max(current.cursor - 1, 0) });
        else if (key.return) {
          setMode({ kind: "host", entry: current.entry, skill: current.candidates[current.cursor]!, cursor: 0, selected: defaultAdoptionHosts(current.entry) });
        }
        return;
      case "host": {
        const toggle = (host: ProjectHost) =>
          HOST_CHOICES.filter((candidate) => candidate === host ? !current.selected.includes(candidate) : current.selected.includes(candidate));
        if (key.escape) cancel("Adoption cancelled");
        else if (key.downArrow || input === "j") setMode({ ...current, cursor: Math.min(current.cursor + 1, HOST_CHOICES.length - 1) });
        else if (key.upArrow || input === "k") setMode({ ...current, cursor: Math.max(current.cursor - 1, 0) });
        else if (input === " ") setMode({ ...current, selected: toggle(HOST_CHOICES[current.cursor]!) });
        else if (HOST_CHOICES[Number(input) - 1]) setMode({ ...current, selected: toggle(HOST_CHOICES[Number(input) - 1]!) });
        else if (key.return) {
          if (current.selected.length > 0) setMode({ kind: "version", entry: current.entry, skill: current.skill, hosts: current.selected });
          else setMessage({ kind: "error", text: "Select at least one host" });
        }
        return;
      }
      case "version":
        if (key.escape) cancel("Adoption cancelled");
        else if (input === "1") void prepare(current, { policy: "latest" });
        else if (input === "2") setMode({ ...current, kind: "fixed", value: "" });
        return;
      case "fixed":
        if (key.escape) cancel("Adoption cancelled");
        else if (key.return) {
          if (isValidFixedVersion(current.value)) void prepare(current, { policy: "fixed", version: current.value });
        } else if (key.backspace || key.delete) setMode({ ...current, value: current.value.slice(0, -1) });
        else if (input !== "" && !key.ctrl && !key.meta) setMode({ ...current, value: current.value + input });
        return;
      case "confirm":
        if (!current.adoption.verdict.adoptable) {
          if (key.escape || key.return || input === "n") cancel("Adoption cancelled");
        } else if (input === "y") {
          if (current.adoption.prepared.additionalHostExposure) setMode({ ...current, kind: "confirm-exposure" });
          else void confirm(current, false);
        } else if (input === "n" || key.escape) cancel("Adoption cancelled");
        return;
      case "confirm-exposure":
        if (input === "y") void confirm(current, true);
        else if (input === "n" || key.escape) cancel("Adoption cancelled");
        return;
      default:
        return;
    }
  };

  useInput((input, key) => {
    const current = modeRef.current;
    if (current.kind !== "browse") {
      handleModeKey(current, input, key);
      return;
    }
    const { open, visible, at } = latest();
    const row = visible[at];
    if (key.downArrow || input === "j") moveTo(visible, at + 1);
    else if (key.upArrow || input === "k") moveTo(visible, at - 1);
    else if (key.pageDown) moveTo(visible, at + pageStep(height));
    else if (key.pageUp) moveTo(visible, at - pageStep(height));
    else if (key.rightArrow && row) setExpanded(expandNode(open, row));
    else if (key.leftArrow && row) {
      const next = collapseOrParent(open, visible, at);
      setExpanded(next.expanded);
      setSelection({ id: next.selectedId, index: at });
    } else if (input === "A" || key.return || input === "u" || input === "h" || input === "i") {
      if (!row || !data) return;
      const item = row.node.data;
      if (item.kind === "group") {
        if (key.return) setExpanded(toggleNode(open, row));
        else setMessage({ kind: "error", text: GROUP_ROW_MESSAGE[input as keyof typeof GROUP_ROW_MESSAGE] });
        return;
      }
      setMessage(undefined);
      if (item.kind === "unmanaged") {
        if (input === "u") startUnmanagedRemoval(manage, item.group);
        else if (input === "A" || key.return) void startAdoption(item.group);
        else setMessage({ kind: "error", text: "Host changes are not available for unmanaged skills" });
        return;
      }
      if (input === "A" || key.return) {
        setMessage({ kind: "error", text: "Adoption applies to unmanaged skills; u uninstalls and h adds hosts here" });
        return;
      }
      if (item.row.scope === "project") {
        setMessage({ kind: "error", text: input === "u" ? "Project uninstall is not supported" : "Project installations are managed with the CLI" });
        return;
      }
      const sourceId = sourceIdOf(item.row.selection, data.sources);
      if (sourceId === undefined) {
        setMessage({ kind: "error", text: "The Source of this installation is no longer registered" });
        return;
      }
      const skill = skillOf(item.row, sourceId);
      if (input === "u") startUninstall(manage, skill);
      else startHostAddition(manage, skill);
    }
  });

  if (state.status === "loading") return <Text>Loading installations...</Text>;
  if (state.status === "error") return <Text color={theme.error}>Error: {state.message}</Text>;
  const ready = state.data;
  const window = computeWindow(rows.length, index, height);

  return (
    <Box flexDirection="column">
      {ready.global === undefined ? <Text>User-global installations are not supported by the configured operations</Text> : null}
      {ready.projectError === undefined ? null : <Text color={theme.error}>Error: {ready.projectError}</Text>}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const position = window.start + offset;
        const item = row.node.data;
        const leaf = !row.expandable && item.kind !== "group";
        const prefix = `${position === index ? "> " : "  "}${"  ".repeat(row.depth)}${leaf ? "  " : ""}`;
        return (
          <Text key={row.node.id} {...rowStyle(position === index)} color={item.kind === "group" ? theme.group : undefined}>
            {prefix}{describeNode(row)}
            {item.kind === "installation" ? (
              <Text color={theme.marker}>{"  "}{describeDetails(item.row)}{markersOf(item.row) === "" ? "" : `  ${markersOf(item.row)}`}</Text>
            ) : null}
            {item.kind === "unmanaged" && describeLinks(item.group) !== "" ? (
              <Text color={theme.marker}>{"  "}{describeLinks(item.group)}</Text>
            ) : null}
          </Text>
        );
      })}
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
      {message ? <Text color={message.kind === "error" ? theme.error : theme.success}>{message.text}</Text> : null}
      <Text color={theme.muted}>{LEGEND}</Text>
      <ModePanel mode={mode} />
    </Box>
  );
}

function ModePanel({ mode }: { readonly mode: InstallationsMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "pick":
      return (
        <Box flexDirection="column">
          <Text>Adopt {mode.entry.name}: several Source Skills match. j/k move, Enter select, Esc cancel:</Text>
          {mode.candidates.map((skill, position) => (
            <Text key={`${skill.sourceId}:${skill.path}`}>{position === mode.cursor ? "> " : "  "}{skill.path}  {skill.sourceId}</Text>
          ))}
        </Box>
      );
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Adopt {mode.entry.name} as {mode.skill.path}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          {HOST_CHOICES.map((host, position) => (
            <Text key={host}>{position === mode.cursor ? "> " : "  "}[{mode.selected.includes(host) ? "x" : " "}] {position + 1} {host}</Text>
          ))}
        </Box>
      );
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "confirm":
      return mode.adoption.verdict.adoptable ? (
        <Box flexDirection="column">
          {mode.adoption.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          {mode.adoption.prepared.runsExternalCommand ? <Text color={theme.warning}>This install runs an external command (see above).</Text> : null}
          <Text>Adopt {mode.entry.name}? y/n</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={theme.error}>{mode.adoption.verdict.reason}</Text>
          <Text>Enter/Esc to go back</Text>
        </Box>
      );
    case "confirm-exposure":
      return (
        <Text color={theme.warning}>
          Adopting {mode.entry.name} adds the missing Host location and exposes it to more hosts; this needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    default:
      return <ManagePanel mode={mode} />;
  }
}
