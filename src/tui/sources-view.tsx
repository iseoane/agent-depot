import { Box, Text } from "ink";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { GitSource } from "../git-source.js";
import type { Source, SourceOperations } from "../sources.js";
import { initialMode, modeReducer, type Mode, type ModeEvent } from "./sources-mode.js";
import { rowStyle, theme } from "./theme.js";
import { computeWindow, pageStep, useListHeight } from "./window.js";
import { useKeys } from "./keys.js";
import type { TuiEnvironment } from "./environment.js";
import { useSourcesRecipes, type RecipeRow } from "./sources-recipes.js";

export interface SourcesViewProps {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  /** Reports whether the view is capturing keys (input, confirmation or busy), so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Invoked when the user presses Enter on the highlighted source. */
  readonly onOpenCatalog?: (source: Source) => void;
  /** Rows the list may use; defaults to what the terminal leaves. Injectable for tests. */
  readonly listHeight?: number;
  /** Contextual browse hints for the shell footer. */
  readonly onHintsChange?: (hints: string) => void;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly sources: readonly Source[] };

type SourceRow =
  | { readonly id: string; readonly kind: "skills"; readonly source: GitSource }
  | { readonly id: string; readonly kind: "app"; readonly recipe: RecipeRow };

type Selection = { readonly id?: string; readonly index: number };

/** Footer keys for the selected row; App seeds the footer before the view reports a selection. */
export function sourceRowHints(row: { readonly kind: "skills" | "app" } | undefined): string {
  if (row === undefined) return "n add · q quit";
  return row.kind === "app"
    ? "j/k move · Enter preview/approve · n add · r refresh · d remove · q quit"
    : "j/k move · space mark · a all · Enter catalog · n add · r refresh · d remove · q quit";
}

/** The highlighted index: by stable id while that source exists, otherwise the bounded fallback index. */
function resolveIndex(sources: readonly { readonly id: string }[], selection: Selection): number {
  const found = sources.findIndex((source) => source.id === selection.id);
  return found >= 0 ? found : Math.min(selection.index, Math.max(sources.length - 1, 0));
}

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** Refreshes each source in order; one failure is reported and does not stop the others. */
async function refreshEach(operations: SourceOperations, targets: readonly GitSource[]): Promise<Message> {
  const lines: string[] = [];
  let failed = false;
  for (const source of targets) {
    try {
      lines.push(`Refreshed Git Source: ${(await operations.refreshSource(source.id)).id}`);
    } catch (error) {
      failed = true;
      lines.push(`Failed ${source.id}: ${errorText(error)}`);
    }
  }
  return { kind: failed ? "error" : "ok", text: lines.join("\n") };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SourcesView({ operations, onCapturingChange, onOpenCatalog, listHeight, environment, onHintsChange }: SourcesViewProps) {
  const height = useListHeight(listHeight, 9);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // The highlight follows the source id; the index is only the fallback once that source is gone.
  // Selection and marks are mirrored in refs updated first, so keys delivered in one burst act on the latest state.
  const [selection, setSelectionState] = useState<Selection>({ index: 0 });
  const selectionRef = useRef<Selection>({ index: 0 });
  const setSelection = (next: Selection) => {
    selectionRef.current = next;
    setSelectionState(next);
  };
  const [mode, dispatchMode] = useReducer(modeReducer, initialMode);
  // Mirrors the mode synchronously so the shell and later keystrokes never see a stale capturing state.
  const modeRef = useRef<Mode>(initialMode);
  const mounted = useRef(true);
  const [message, setMessage] = useState<Message | undefined>();
  // Git sources marked for a combined refresh; the built-in source can never be marked.
  const [marked, setMarkedState] = useState<ReadonlySet<string>>(new Set());
  const markedRef = useRef<ReadonlySet<string>>(new Set());
  const setMarked = (next: ReadonlySet<string>) => {
    markedRef.current = next;
    setMarkedState(next);
  };
  // Mirrors the typed URL synchronously so keystrokes delivered in one burst are not lost to stale closures.
  const typed = useRef("");

  const reload = useCallback(async () => {
    try {
      const sources = await operations.listSources();
      if (mounted.current) setState({ status: "ready", sources });
    } catch (error) {
      if (mounted.current) setState({ status: "error", message: errorText(error) });
    }
  }, [operations]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dispatch = (event: ModeEvent) => {
    modeRef.current = modeReducer(modeRef.current, event);
    onCapturingChange?.(modeRef.current.kind !== "browse");
    dispatchMode(event);
  };

  useEffect(() => {
    let cancelled = false;
    operations.listSources().then(
      (sources) => {
        if (!cancelled) setState({ status: "ready", sources });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [operations]);

  const allSources = state.status === "ready" ? state.sources : [];
  const builtin = allSources.find((source) => source.kind === "builtin");
  // The built-in source is a fixed row; only Git sources are selectable and navigable.
  const sources = allSources.filter((source): source is GitSource => source.kind === "git");
  const sourcesRef = useRef<readonly GitSource[]>(sources);
  sourcesRef.current = sources;
  const rowsRef = useRef<readonly SourceRow[]>([]);
  const recipes = useSourcesRecipes({
    operations, environment, onCapturingChange,
    highlightedFile: () => {
      const rows = rowsRef.current;
      const row = rows[resolveIndex(rows, selectionRef.current)];
      return row?.kind === "app" ? row.recipe.entry.file : undefined;
    },
  });
  const rows: readonly SourceRow[] = [
    ...sources.map((source): SourceRow => ({ id: source.id, kind: "skills", source })),
    ...recipes.rows.map((recipe): SourceRow => ({ id: `recipe:${recipe.entry.file}`, kind: "app", recipe })),
  ];
  rowsRef.current = rows;
  const selected = resolveIndex(rows, selection);
  const selectedRow = rows[selected];
  const hints = sourceRowHints(selectedRow);
  useEffect(() => { onHintsChange?.(hints); }, [hints, onHintsChange]);
  const select = (index: number) => {
    setMessage(undefined);
    recipes.clearMessage();
    const listed = rowsRef.current;
    const bounded = Math.min(Math.max(index, 0), Math.max(listed.length - 1, 0));
    setSelection({ id: listed[bounded]?.id, index: bounded });
  };

  /** Runs a mutating action in the busy mode, reports its outcome and reloads the list. */
  const run = async (action: () => Promise<string | Message>) => {
    dispatch({ type: "busy" });
    setMessage(undefined);
    let outcome: Message;
    try {
      const result = await action();
      outcome = typeof result === "string" ? { kind: "ok", text: result } : result;
    } catch (error) {
      outcome = { kind: "error", text: `Error: ${errorText(error)}` };
    }
    if (!mounted.current) return;
    setMessage(outcome);
    await reload();
    if (mounted.current) dispatch({ type: "done" });
  };

  /** Marks the given ids, or unmarks them all when every one is already marked. */
  const toggle = (ids: readonly string[]) => {
    const next = new Set(markedRef.current);
    if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    setMarked(next);
  };

  const stop = (text: string) => setMessage({ kind: "error", text });

  const startRemoval = async (source: GitSource) => {
    if (!operations.listUserGlobalInstallations || !operations.removeGitSource) {
      stop("Removing sources is not supported by the configured operations");
      return;
    }
    dispatch({ type: "busy" });
    setMessage(undefined);
    try {
      const installations = await operations.listUserGlobalInstallations();
      if (!mounted.current) return;
      const dependent = installations.some(
        (selection) => selection.source.kind === "external" && "url" in selection.source && selection.source.url === source.url,
      );
      if (dependent) {
        stop(`Dependent user-global Skills exist; run \`agent-depot source remove ${source.id}\` in the CLI`);
        dispatch({ type: "done" });
      } else {
        dispatch({ type: "confirm", action: "remove", source });
      }
    } catch (error) {
      if (!mounted.current) return;
      stop(`Error: ${errorText(error)}`);
      dispatch({ type: "done" });
    }
  };

  useKeys((input, key) => {
    const mode = modeRef.current;
    if (mode.kind === "busy") return;
    if (mode.kind === "add-kind") {
      if (key.escape || input === "n") dispatch({ type: "done" });
      else if (input === "1") { typed.current = ""; dispatch({ type: "input" }); }
      else if (input === "2") { dispatch({ type: "done" }); recipes.startAdd(); }
      return;
    }
    if (mode.kind === "input") {
      if (key.escape) dispatch({ type: "done" });
      else if (key.return) {
        const url = typed.current.trim();
        if (url === "") return;
        void run(async () => `Added Git Source: ${(await operations.addGitSource(url)).id}`);
      } else if (key.backspace || key.delete) {
        typed.current = typed.current.slice(0, -1);
        dispatch({ type: "edit", value: typed.current });
      } else if (input !== "" && !key.ctrl && !key.meta) {
        typed.current += input;
        dispatch({ type: "edit", value: typed.current });
      }
      return;
    }
    if (mode.kind === "confirm") {
      if (input === "y") {
        if (mode.action === "refresh") {
          const { sources: targets } = mode;
          void run(async () => {
            const result = await refreshEach(operations, targets);
            setMarked(new Set());
            return result;
          });
        } else {
          const { source } = mode;
          void run(async () => {
            await operations.removeGitSource?.(source.id);
            return `Removed Git Source: ${source.id}`;
          });
        }
      } else if (input === "n" || key.escape) dispatch({ type: "done" });
      return;
    }

    if (recipes.handleKey(input, key)) return;

    const rows = rowsRef.current;
    const at = resolveIndex(rows, selectionRef.current);
    const row = rows[at];
    const listed = sourcesRef.current;
    const highlighted = row?.kind === "skills" ? row.source : undefined;
    if (key.downArrow || input === "j") {
      select(at + 1);
    } else if (key.upArrow || input === "k") {
      select(at - 1);
    } else if (key.pageDown) {
      select(at + pageStep(height));
    } else if (key.pageUp) {
      select(at - pageStep(height));
    } else if (key.return && highlighted) {
      onOpenCatalog?.(highlighted);
    } else if (input === "n") {
      setMessage(undefined);
      dispatch({ type: "add-kind" });
    } else if (input === " " && highlighted) {
      setMessage(undefined);
      toggle([highlighted.id]);
    } else if (input === "a" && row?.kind !== "app") {
      if (listed.length === 0) stop("There are no Git sources to select");
      else {
        setMessage(undefined);
        toggle(listed.map((source) => source.id));
      }
    } else if (input === "r" && row?.kind !== "app") {
      const targets = markedRef.current.size > 0
        ? listed.filter((source) => markedRef.current.has(source.id))
        : highlighted ? [highlighted] : [];
      if (targets.length > 0) {
        setMessage(undefined);
        dispatch({ type: "confirm", action: "refresh", sources: targets });
      }
    } else if (input === "d" && highlighted) {
      void startRemoval(highlighted);
    }
  });

  // Sources removed since they were marked no longer count.
  const selectedCount = sources.filter((source) => marked.has(source.id)).length;

  if (state.status === "loading") return <Text>Loading sources...</Text>;
  if (state.status === "error") return <Text color={theme.error}>Error: {state.message}</Text>;

  const window = computeWindow(rows.length, selected, height);

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{"      "}ID  KIND  LOCATION / STATUS</Text>
      {builtin ? <Text color={theme.muted}>{"    "}{builtin.id}  skills  included</Text> : null}
      {rows.length === 0 ? <Text>No sources or App recipes · n to add</Text> : null}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const index = window.start + offset;
        const id = row.kind === "skills" ? row.source.id : row.recipe.entry.recipe?.name ?? row.recipe.entry.file.split(/[\\/]/u).pop();
        return (
          <Text key={row.id} {...rowStyle(index === selected)}>
            {index === selected ? "> " : "  "}
            {row.kind === "skills" ? (marked.has(row.id) ? "[x] " : "[ ] ") : "    "}
            {id}  {row.kind}  {row.kind === "skills" ? row.source.url : `${row.recipe.entry.file} · ${row.recipe.status}`}
          </Text>
        );
      })}
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
      {selectedCount > 0 ? <Text>{selectedCount} selected</Text> : null}
      {recipes.panel}
      <Prompt mode={mode} />
      {message ? <Text color={message.kind === "error" ? theme.error : theme.success}>{message.text}</Text> : null}
    </Box>
  );
}

function Prompt({ mode }: { readonly mode: Mode }) {
  if (mode.kind === "add-kind") return <Text>Add: 1 Skill Source · 2 App recipe (Esc cancel)</Text>;
  if (mode.kind === "input") return <Text>URL: {mode.value}</Text>;
  if (mode.kind === "busy") return <Text>Working...</Text>;
  if (mode.kind === "confirm") {
    const lines = mode.action === "refresh"
      ? mode.sources.map((source) => `refresh Git Source ${source.id} from ${source.url}`)
      : [`remove Git Source ${mode.source.id} from ${mode.source.url}`];
    return <Text>{lines.join("\n")}{"\n"}[y/n]</Text>;
  }
  return null;
}
