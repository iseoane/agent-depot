import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { rowStyle, theme } from "./theme.js";
import { computeWindow, pageStep, useListHeight } from "./window.js";
import { BROWSE, type UpdatesMode } from "./updates-mode.js";
import {
  loadUpdateRows,
  prepareUpdates,
  runUpdates,
  type PreparedUpdates,
  type UpdateScope,
  type UpdatesData,
} from "./updates.js";

export interface UpdatesViewProps {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  /** Reports whether the view is capturing keys, so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Rows the list may use; defaults to what the terminal leaves. Injectable for tests. */
  readonly listHeight?: number;
}

const NO_ENVIRONMENT: TuiEnvironment = {};

interface Message {
  readonly kind: "ok" | "error";
  readonly lines: readonly string[];
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: UpdatesData };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function UpdatesView({ operations, environment, onCapturingChange, listHeight }: UpdatesViewProps) {
  const height = useListHeight(listHeight, 7);
  const env = environment ?? NO_ENVIRONMENT;
  const [scope, setScope] = useState<UpdateScope>("project");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [cursor, setCursor] = useState(0);
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setMode = useCallback((next: UpdatesMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  }, [onCapturingChange]);

  const load = useCallback(async (target: UpdateScope) => {
    const token = ++loadToken.current;
    setState({ status: "loading" });
    setChecked([]);
    setCursor(0);
    setMode({ kind: "busy", label: "Checking for updates..." });
    let next: LoadState;
    try {
      next = { status: "ready", data: await loadUpdateRows(operations, env, target) };
    } catch (error) {
      next = { status: "error", message: errorText(error) };
    }
    // A newer check (scope switch or `r`) supersedes this one.
    if (!mounted.current || token !== loadToken.current) return;
    setState(next);
    setMode(BROWSE);
  }, [operations, env, setMode, setChecked]);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  const data = state.status === "ready" ? state.data : undefined;
  const rows = data?.rows ?? [];
  const index = Math.min(cursor, Math.max(rows.length - 1, 0));

  const cancel = () => {
    setMessage({ kind: "ok", lines: ["Update cancelled"] });
    setMode(BROWSE);
  };

  const startPreview = async () => {
    if (!data) return;
    const selected = rows.filter((row) => checkedRef.current.includes(row.item.id)).map((row) => row.item);
    if (selected.length === 0) {
      setMessage({ kind: "error", lines: ["Select at least one update with space or a"] });
      return;
    }
    setMessage(undefined);
    setMode({ kind: "busy", label: "Preparing preview..." });
    try {
      const prepared = await prepareUpdates(data, selected);
      if (mounted.current) setMode({ kind: "preview", selected, prepared });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", lines: [errorText(error)] });
      setMode(BROWSE);
    }
  };

  const apply = async (prepared: PreparedUpdates, confirmedPaths: readonly string[]) => {
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
    await load(scope);
  };

  useInput((input, key) => {
    const current = modeRef.current;
    switch (current.kind) {
      case "browse":
        if (key.downArrow || input === "j") setCursor(Math.min(index + 1, Math.max(rows.length - 1, 0)));
        else if (key.upArrow || input === "k") setCursor(Math.max(index - 1, 0));
        else if (key.pageDown) setCursor(Math.min(index + pageStep(height), Math.max(rows.length - 1, 0)));
        else if (key.pageUp) setCursor(Math.max(index - pageStep(height), 0));
        else if (input === " ") {
          const row = rows[index];
          if (row?.item.status !== "updateable") return;
          const now = checkedRef.current;
          setChecked(now.includes(row.item.id) ? now.filter((id) => id !== row.item.id) : [...now, row.item.id]);
        } else if (input === "a") {
          setChecked(rows.filter((row) => row.item.status === "updateable").map((row) => row.item.id));
        } else if (input === "p" || input === "g") {
          const next = input === "p" ? "project" : "user-global";
          setMessage(undefined);
          if (next === scope) void load(scope);
          else setScope(next);
        } else if (input === "r") {
          setMessage(undefined);
          void load(scope);
        } else if (key.return) void startPreview();
        return;
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

  const window = computeWindow(rows.length, index, height);

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>Updates (scope: {scope})  p project  g user-global  r check again</Text>
      {state.status === "loading" ? <Text>Checking for updates...</Text> : null}
      {state.status === "error" ? <Text color={theme.error}>Error: {state.message}</Text> : null}
      {data && rows.length === 0 ? <Text>No installations</Text> : null}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const position = window.start + offset;
        const box = row.item.status === "updateable" ? (checked.includes(row.item.id) ? "[x]" : "[ ]") : "   ";
        return (
          <Box key={row.item.id} flexDirection="column">
            <Text {...rowStyle(position === index)}>
              {position === index ? "> " : "  "}{box} {row.path}  {row.policy}  {row.installed} {"->"} {row.available}  {row.status}
            </Text>
            {row.item.status === "unknown" ? <Text color={theme.muted}>{"        "}{row.reason}</Text> : null}
          </Box>
        );
      })}
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
      {data && rows.length > 0 ? <Text color={theme.muted}>{checked.length} selected</Text> : null}
      {message ? (
        <Box flexDirection="column">
          {message.lines.map((line, position) => <Text key={position} color={message.kind === "error" ? theme.error : theme.success}>{line}</Text>)}
        </Box>
      ) : null}
      <ModePanel mode={mode} />
    </Box>
  );
}

function ModePanel({ mode }: { readonly mode: UpdatesMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "busy":
      return mode.label === "Checking for updates..." ? null : <Text>{mode.label}</Text>;
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
          {mode.prepared.nonCanonicalPaths.map((location) => <Text key={location} color={theme.warning}>  {JSON.stringify(location)}</Text>)}
          <Text>Replace exactly these paths? y/n</Text>
        </Box>
      );
  }
}
