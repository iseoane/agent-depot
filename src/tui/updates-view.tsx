import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { rowStyle, theme } from "./theme.js";
import { computeWindow, pageStep, useListHeight } from "./window.js";
import { BROWSE, type UpdatesMode } from "./updates-mode.js";
import {
  formatAgo,
  loadUpdateRows,
  prepareUpdates,
  runUpdates,
  type PreparedUpdates,
  type ScopedPath,
  type UpdateRow,
  type UpdateScopeFilter,
  type UpdatesData,
  type UpdatesPhase,
} from "./updates.js";
import { useKeys } from "./keys.js";

export interface UpdatesViewProps {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  /** Reports whether the view is capturing keys, so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Rows the list may use; defaults to what the terminal leaves. Injectable for tests. */
  readonly listHeight?: number;
  /** Clock for the age of the check; injectable for tests. */
  readonly now?: () => number;
}

const NO_ENVIRONMENT: TuiEnvironment = {};
const REFRESHING = "Refreshing sources...";
const CHECKING = "Checking for updates...";
const PHASE_LABEL: Record<UpdatesPhase, string> = { refreshing: REFRESHING, checking: CHECKING };
/** How often the age of the check is redrawn. */
const CLOCK_TICK_MS = 10_000;

interface Message {
  readonly kind: "ok" | "error";
  readonly lines: readonly string[];
}

type LoadState =
  | { readonly status: "loading"; readonly label: string }
  | { readonly status: "ready"; readonly data: UpdatesData };

/** A line the cursor can be on: an updatable item, the fold of unassessable ones, or one of those when unfolded. */
type Entry =
  | { readonly kind: "update"; readonly row: UpdateRow }
  | { readonly kind: "summary" }
  | { readonly kind: "unknown"; readonly row: UpdateRow };

/** Names the reasons worth knowing before expanding the collapsed "cannot be checked" row. */
function describeUnknownReasons(rows: readonly UpdateRow[]): string {
  const newer = rows.filter((row) => /^installed by a newer agent depot/i.test(row.reason)).length;
  const pinned = rows.filter((row) => /^pinned to agent depot/i.test(row.reason)).length;
  const parts = [
    ...(newer > 0 ? [`${newer} installed by a newer Agent Depot`] : []),
    ...(pinned > 0 ? [`${pinned} pinned to another Agent Depot`] : []),
  ];
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const matchesScope = (row: UpdateRow, filter: UpdateScopeFilter): boolean => filter === "all" || row.scope === filter;

/** The rows the list shows for a scope filter and fold state, and the cursor positions they make up. */
function viewOf(data: UpdatesData | undefined, scope: UpdateScopeFilter, showUnknown: boolean) {
  const shown = (data?.rows ?? []).filter((row) => matchesScope(row, scope));
  const updatable = shown.filter((row) => row.item.status === "updateable");
  const unknown = shown.filter((row) => row.item.status === "unknown");
  const upToDate = shown.filter((row) => row.item.status === "current").length;
  const entries: readonly Entry[] = [
    ...updatable.map((row): Entry => ({ kind: "update", row })),
    ...(unknown.length > 0 ? [{ kind: "summary" } as const] : []),
    ...(unknown.length > 0 && showUnknown ? unknown.map((row): Entry => ({ kind: "unknown", row })) : []),
  ];
  return { shown, updatable, unknown, upToDate, entries };
}

function describeRefresh(data: UpdatesData): string {
  const { attempted, refreshed, failed, unreadable } = data.refresh;
  if (!attempted) return "sources not fetched again";
  if (unreadable.length > 0) {
    return `could not refresh: ${unreadable.map(({ scope, reason }) => `${reason} (${scope})`).join("; ")}; cached data was used`;
  }
  if (failed.length > 0) {
    return `${failed.length} of ${failed.length + refreshed.length} sources could not be refreshed; their current data was used`;
  }
  return refreshed.length > 0 ? "sources refreshed" : "no Git sources to refresh";
}

export function UpdatesView({ operations, environment, onCapturingChange, listHeight, now }: UpdatesViewProps) {
  const height = useListHeight(listHeight, 9);
  const env = environment ?? NO_ENVIRONMENT;
  const clock = now ?? Date.now;
  // Scope, cursor and fold are mirrored in refs updated first, so keys delivered in one burst act on the latest state.
  const [scope, setScopeState] = useState<UpdateScopeFilter>("all");
  const scopeRef = useRef<UpdateScopeFilter>("all");
  const setScope = (next: UpdateScopeFilter) => {
    scopeRef.current = next;
    setScopeState(next);
  };
  const [state, setState] = useState<LoadState>({ status: "loading", label: REFRESHING });
  const [cursor, setCursorState] = useState(0);
  const cursorRef = useRef(0);
  const setCursor = useCallback((next: number) => {
    cursorRef.current = next;
    setCursorState(next);
  }, []);
  const [showUnknown, setShowUnknownState] = useState(false);
  const showUnknownRef = useRef(false);
  const setShowUnknown = (next: boolean) => {
    showUnknownRef.current = next;
    setShowUnknownState(next);
  };
  const [checked, setCheckedState] = useState<readonly string[]>([]);
  // Mirrors the selection synchronously so a key pressed right after a toggle sees it.
  const checkedRef = useRef<readonly string[]>([]);
  const setChecked = useCallback((next: readonly string[]) => {
    checkedRef.current = next;
    setCheckedState(next);
  }, []);
  const [mode, setModeState] = useState<UpdatesMode>(BROWSE);
  // Mirrors the mode synchronously so later keystrokes and the shell never see stale state.
  const modeRef = useRef<UpdatesMode>(BROWSE);
  const mounted = useRef(true);
  const loadToken = useRef(0);
  const [message, setMessage] = useState<Message | undefined>();
  // Only redraws, so "checked 5 min ago" moves on without a key press.
  const [, setTick] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setTick((value) => value + 1), CLOCK_TICK_MS);
    // A redraw timer alone must never keep the process alive.
    timer.unref();
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);

  const setMode = useCallback((next: UpdatesMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  }, [onCapturingChange]);

  const load = useCallback(async (refresh: boolean) => {
    const token = ++loadToken.current;
    const phase = (next: UpdatesPhase) => {
      if (!mounted.current || token !== loadToken.current) return;
      setState({ status: "loading", label: PHASE_LABEL[next] });
    };
    setChecked([]);
    setCursor(0);
    setMode({ kind: "busy", label: refresh ? REFRESHING : CHECKING });
    let next: LoadState;
    try {
      next = { status: "ready", data: await loadUpdateRows(operations, env, { refresh, onPhase: phase, now: clock }) };
    } catch (error) {
      // The scopes are read separately, so this is unexpected; show it as the check's result.
      next = { status: "ready", data: emptyData(errorText(error), clock()) };
    }
    // A newer check (`r`) supersedes this one.
    if (!mounted.current || token !== loadToken.current) return;
    setState(next);
    setMode(BROWSE);
  }, [operations, env, setMode, setChecked, setCursor, clock]);

  // Entering the view refreshes the Git sources first, like `r`.
  useEffect(() => {
    void load(true);
  }, [load]);

  const data = state.status === "ready" ? state.data : undefined;
  const dataRef = useRef(data);
  dataRef.current = data;
  const { shown, updatable, unknown, upToDate, entries } = viewOf(data, scope, showUnknown);
  const index = Math.min(cursor, Math.max(entries.length - 1, 0));

  /** The list, the cursor and the fold as of the latest keystroke. */
  const latest = () => {
    const view = viewOf(dataRef.current, scopeRef.current, showUnknownRef.current);
    return { ...view, data: dataRef.current, at: Math.min(cursorRef.current, Math.max(view.entries.length - 1, 0)) };
  };

  const changeScope = (next: UpdateScopeFilter) => {
    if (next === scopeRef.current) return;
    // Selected items that the new filter hides would otherwise be applied unseen.
    setChecked([]);
    setCursor(0);
    setMessage(undefined);
    setScope(next);
  };

  const cancel = () => {
    setMessage({ kind: "ok", lines: ["Update cancelled"] });
    setMode(BROWSE);
  };

  const startPreview = async () => {
    const { data: current, updatable: listed } = latest();
    if (!current) return;
    const selected = listed.filter((row) => checkedRef.current.includes(row.key));
    if (selected.length === 0) {
      setMessage({ kind: "error", lines: ["Select at least one update with space or a"] });
      return;
    }
    setMessage(undefined);
    setMode({ kind: "busy", label: "Preparing preview..." });
    try {
      const prepared = await prepareUpdates(current, selected);
      if (mounted.current) setMode({ kind: "preview", selected: selected.map((row) => row.item), prepared });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", lines: [errorText(error)] });
      setMode(BROWSE);
    }
  };

  const apply = async (prepared: PreparedUpdates, confirmedPaths: readonly ScopedPath[]) => {
    setMode({ kind: "busy", label: "Applying updates..." });
    let result: Message;
    try {
      const outcome = await runUpdates(prepared, confirmedPaths);
      result = { kind: outcome.failed === 0 ? "ok" : "error", lines: outcome.lines };
    } catch (error) {
      result = { kind: "error", lines: [errorText(error)] };
    }
    if (!mounted.current) return;
    setMessage(result);
    // The sources were fetched for the check that was just applied; only the installations changed.
    await load(false);
  };

  useKeys((input, key) => {
    const current = modeRef.current;
    switch (current.kind) {
      case "browse": {
        const { entries: listed, updatable: updates, at, data: loaded } = latest();
        const last = Math.max(listed.length - 1, 0);
        const entry = listed[at];
        if (key.downArrow || input === "j") setCursor(Math.min(at + 1, last));
        else if (key.upArrow || input === "k") setCursor(Math.max(at - 1, 0));
        else if (key.pageDown) setCursor(Math.min(at + pageStep(height), last));
        else if (key.pageUp) setCursor(Math.max(at - pageStep(height), 0));
        else if (input === " ") {
          if (entry?.kind !== "update") return;
          const now = checkedRef.current;
          setChecked(now.includes(entry.row.key) ? now.filter((id) => id !== entry.row.key) : [...now, entry.row.key]);
        } else if (input === "a") setChecked(updates.map((row) => row.key));
        else if (input === "t") changeScope("all");
        else if (input === "p") changeScope("project");
        else if (input === "g") changeScope("user-global");
        else if (input === "r") {
          setMessage(undefined);
          setShowUnknown(false);
          void load(true);
        } else if (key.rightArrow) {
          if (entry?.kind === "summary") setShowUnknown(true);
        } else if (key.leftArrow) {
          if (entry?.kind === "unknown") setCursor(updates.length);
          if (entry?.kind === "summary" || entry?.kind === "unknown") setShowUnknown(false);
        } else if (key.return) {
          if (entry?.kind === "summary") setShowUnknown(!showUnknownRef.current);
          else if (entry?.kind !== "unknown" && loaded) void startPreview();
        }
        return;
      }
      case "preview":
        if (current.prepared.applicable.length === 0) {
          if (key.escape || key.return || input === "n") cancel();
        } else if (input === "y") {
          if (current.prepared.nonCanonicalPaths.length > 0) setMode({ ...current, kind: "confirm-paths" });
          else void apply(current.prepared, []);
        } else if (input === "n" || key.escape) cancel();
        return;
      case "confirm-paths":
        if (input === "y") void apply(current.prepared, current.prepared.nonCanonicalPaths);
        else if (input === "n" || key.escape) cancel();
        return;
      default:
        return;
    }
  });

  const window = computeWindow(entries.length, index, height);
  const errors = (data?.results ?? []).filter((result) => result.error !== undefined);

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>Updates (scope: {scope})  t all · p project · g user-global</Text>
      {state.status === "loading" ? <Text>{state.label}</Text> : null}
      {data ? (
        <Text color={theme.muted}>checked {formatAgo(clock() - data.checkedAt)} · {describeRefresh(data)}</Text>
      ) : null}
      {data?.refresh.failed.map((failure) => (
        <Text key={failure.source} color={theme.warning}>refresh failed for {failure.source}: {failure.reason}</Text>
      ))}
      {errors.map((result) => <Text key={result.scope} color={theme.error}>Error ({result.scope}): {result.error}</Text>)}
      {data && errors.length === 0 && shown.length === 0 ? <Text>No installations</Text> : null}
      {entries.slice(window.start, window.end).map((entry, offset) => {
        const position = window.start + offset;
        const selected = position === index;
        if (entry.kind === "summary") {
          return (
            <Text key="summary" {...rowStyle(selected)} color={theme.inactive}>
              {selected ? "> " : "  "}{unknown.length} cannot be checked {showUnknown ? "▾" : "▸"}{describeUnknownReasons(unknown)}
            </Text>
          );
        }
        const { row } = entry;
        if (entry.kind === "unknown") {
          return (
            <Box key={row.key} flexDirection="column">
              <Text {...rowStyle(selected)}>{selected ? "> " : "  "}    {row.path}  {row.scope}</Text>
              <Text color={theme.muted}>{"        "}{row.reason}</Text>
            </Box>
          );
        }
        return (
          <Text key={row.key} {...rowStyle(selected)}>
            {selected ? "> " : "  "}{checked.includes(row.key) ? "[x]" : "[ ]"} {row.path}  {row.scope}  {row.policy}  {row.installed} {"->"} {row.available}
          </Text>
        );
      })}
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
      {data && upToDate > 0 ? <Text color={theme.muted}>{upToDate} up to date</Text> : null}
      {data && updatable.length > 0 ? <Text color={theme.muted}>{checked.length} selected</Text> : null}
      {message ? (
        <Box flexDirection="column">
          {message.lines.map((line, position) => <Text key={position} color={message.kind === "error" ? theme.error : theme.success}>{line}</Text>)}
        </Box>
      ) : null}
      <ModePanel mode={mode} />
    </Box>
  );
}

/** Data for a check that failed as a whole, so the view can show the reason. */
function emptyData(reason: string, checkedAt: number): UpdatesData {
  return {
    results: [{ scope: "project", error: reason }],
    rows: [],
    refresh: { attempted: false, refreshed: [], failed: [], unreadable: [] },
    checkedAt,
  };
}

function ModePanel({ mode }: { readonly mode: UpdatesMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "busy":
      return mode.label === REFRESHING || mode.label === CHECKING ? null : <Text>{mode.label}</Text>;
    case "preview":
      return (
        <Box flexDirection="column">
          {mode.prepared.lines.map((line, position) => <Text key={position}>{line}</Text>)}
          {mode.prepared.failures.map(({ item, message }) => (
            <Text key={item.id} color={theme.error}>Preview failed for {JSON.stringify(item.id)}: {message}</Text>
          ))}
          {mode.prepared.applicable.length === 0
            ? <Text>Nothing can be applied. Enter/Esc to go back</Text>
            : <Text>Apply {mode.prepared.applicable.length} {mode.prepared.applicable.length === 1 ? "update" : "updates"}? y/n</Text>}
        </Box>
      );
    case "confirm-paths":
      return (
        <Box flexDirection="column">
          <Text color={theme.warning}>Confirm replacing non-canonical locations (outside .agents/skills and .claude/skills):</Text>
          {mode.prepared.nonCanonicalPaths.map((location, position) => <Text key={position} color={theme.warning}>  [{location.scope}] {JSON.stringify(location.path)}</Text>)}
          <Text>Replace exactly these paths? y/n</Text>
        </Box>
      );
  }
}
