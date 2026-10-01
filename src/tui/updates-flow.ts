import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { errorText } from "./batch.js";
import type { TuiEnvironment } from "./environment.js";
import type { SourceOperations } from "../sources.js";
import { BROWSE, type UpdatesMode } from "./updates-mode.js";
import type { UpdatesSnapshot } from "./updates-keys.js";
import { CHECKING, emptyData, PHASE_LABEL, REFRESHING, type LoadState, type UpdatesMessage } from "./updates-model.js";
import { loadUpdateRows, prepareUpdates, runUpdates, type PreparedUpdates, type ScopedPath, type UpdatesPhase } from "./updates.js";

/** What loading, previewing and applying updates need from the Updates view. */
export interface UpdatesFlowInputs {
  readonly operations: SourceOperations;
  readonly env: TuiEnvironment;
  readonly clock: () => number;
  readonly mounted: MutableRefObject<boolean>;
  readonly checkedRef: MutableRefObject<readonly string[]>;
  readonly latest: () => UpdatesSnapshot;
  readonly setChecked: (next: readonly string[]) => void;
  readonly setCursor: (next: number) => void;
  readonly setMode: (next: UpdatesMode) => void;
  readonly setMessage: (next: UpdatesMessage | undefined) => void;
}

export interface UpdatesFlow {
  readonly state: LoadState;
  /** Checks for updates, fetching the Git sources first when `refresh` is set. */
  readonly load: (refresh: boolean) => Promise<void>;
  /** Prepares the preview of the selected updates. */
  readonly startPreview: () => Promise<void>;
  readonly apply: (prepared: PreparedUpdates, confirmedPaths: readonly ScopedPath[]) => Promise<void>;
}

export function useUpdatesFlow(inputs: UpdatesFlowInputs): UpdatesFlow {
  const { operations, env, clock, mounted, checkedRef, latest, setChecked, setCursor, setMode, setMessage } = inputs;
  const [state, setState] = useState<LoadState>({ status: "loading", label: REFRESHING });
  const loadToken = useRef(0);
  const pendingAnswer = useRef<((done: boolean) => void) | undefined>(undefined);
  useEffect(() => () => {
    pendingAnswer.current?.(false);
  }, []);

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
  }, [operations, env, mounted, setMode, setChecked, setCursor, clock]);

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
      if (mounted.current) setMode({ kind: "preview", prepared });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", lines: [errorText(error)] });
      setMode(BROWSE);
    }
  };

  const apply = async (prepared: PreparedUpdates, confirmedPaths: readonly ScopedPath[]) => {
    setMode({ kind: "busy", label: "Applying updates..." });
    let result: UpdatesMessage;
    try {
      const outcome = await runUpdates(prepared, confirmedPaths, (plan, reason) => new Promise<boolean>(resolve => {
        if (!mounted.current) { resolve(false); return; }
        const answer = (done: boolean) => {
          pendingAnswer.current = undefined;
          resolve(done);
        };
        pendingAnswer.current = answer;
        setMode({ kind: "manual", plan, reason, answer });
      }));
      result = { kind: outcome.failed === 0 ? "ok" : "error", lines: outcome.lines };
    } catch (error) {
      result = { kind: "error", lines: [errorText(error)] };
    }
    if (!mounted.current) return;
    setMessage(result);
    // The sources were fetched for the check that was just applied; only the installations changed.
    await load(false);
  };

  return { state, load, startPreview, apply };
}
