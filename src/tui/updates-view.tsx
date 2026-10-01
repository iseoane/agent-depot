import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { theme } from "./theme.js";
import { computeWindow, useListHeight } from "./window.js";
import { BROWSE, type UpdatesMode } from "./updates-mode.js";
import { useMirrored } from "./view-state.js";
import { useUpdatesFlow } from "./updates-flow.js";
import { handleUpdatesKey, type UpdatesKeyContext } from "./updates-keys.js";
import { viewOf, type UpdatesMessage } from "./updates-model.js";
import { CheckStatus, EntryLine, ModePanel, UpdatesFooter } from "./updates-panel.js";
import type { UpdateScopeFilter, UpdatesData } from "./updates.js";
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
/** How often the age of the check is redrawn. */
const CLOCK_TICK_MS = 10_000;

export function UpdatesView({ operations, environment, onCapturingChange, listHeight, now }: UpdatesViewProps) {
  const height = useListHeight(listHeight, 9);
  const env = environment ?? NO_ENVIRONMENT;
  const clock = now ?? Date.now;
  // Scope, cursor, fold and selection are mirrored in refs updated first, so keys delivered in one burst act on the latest state.
  const [scope, scopeRef, setScope] = useMirrored<UpdateScopeFilter>("all");
  const [cursor, cursorRef, setCursor] = useMirrored(0);
  const [showUnknown, showUnknownRef, setShowUnknown] = useMirrored(false);
  const [checked, checkedRef, setChecked] = useMirrored<readonly string[]>([]);
  const [mode, setModeState] = useState<UpdatesMode>(BROWSE);
  // Mirrors the mode synchronously so later keystrokes and the shell never see stale state.
  const modeRef = useRef<UpdatesMode>(BROWSE);
  const mounted = useRef(true);
  const [message, setMessage] = useState<UpdatesMessage | undefined>();
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

  const dataRef = useRef<UpdatesData | undefined>(undefined);
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

  const { state, load, startPreview, apply } = useUpdatesFlow({
    operations, env, clock, mounted, checkedRef, latest, setChecked, setCursor, setMode, setMessage,
  });

  // Entering the view refreshes the Git sources first, like `r`.
  useEffect(() => {
    void load(true);
  }, [load]);

  const data = state.status === "ready" ? state.data : undefined;
  dataRef.current = data;
  const { shown, updatable, unknown, upToDate, entries } = viewOf(data, scope, showUnknown);
  const index = Math.min(cursor, Math.max(entries.length - 1, 0));

  const keyContext: UpdatesKeyContext = {
    height,
    latest,
    checked: () => checkedRef.current,
    setChecked,
    setCursor,
    unknownShown: () => showUnknownRef.current,
    setShowUnknown,
    changeScope,
    recheck: () => {
      setMessage(undefined);
      setShowUnknown(false);
      void load(true);
    },
    startPreview: () => void startPreview(),
    setMode,
    cancel,
    apply: (prepared, confirmedPaths) => void apply(prepared, confirmedPaths),
  };

  useKeys((input, key) => handleUpdatesKey(keyContext, modeRef.current, input, key));

  const window = computeWindow(entries.length, index, height);
  const view = { shown, updatable, unknown, upToDate, entries };
  const hasErrors = data?.appError !== undefined || (data?.results ?? []).some((result) => result.error !== undefined);

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>Updates (scope: {scope})  t all · p project · g user-global</Text>
      {state.status === "loading" ? <Text>{state.label}</Text> : null}
      {data ? <CheckStatus data={data} now={clock()} /> : null}
      {data && !hasErrors && shown.length === 0 ? <Text>No installations</Text> : null}
      {entries.slice(window.start, window.end).map((entry, offset) => (
        <EntryLine
          key={entry.kind === "summary" ? "summary" : entry.row.key}
          entry={entry}
          selected={window.start + offset === index}
          checked={entry.kind === "update" && checked.includes(entry.row.key)}
          view={view}
          showUnknown={showUnknown}
        />
      ))}
      <UpdatesFooter indicator={window.indicator} upToDate={upToDate} updatableCount={updatable.length} checkedCount={checked.length} message={message} />
      <ModePanel mode={mode} />
    </Box>
  );
}
