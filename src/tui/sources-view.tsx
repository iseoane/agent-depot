import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { GitSource } from "../git-source.js";
import type { Source, SourceOperations } from "../sources.js";
import { initialMode, modeReducer, type Mode, type ModeEvent } from "./sources-mode.js";

export interface SourcesViewProps {
  readonly operations: SourceOperations;
  /** Reports whether the view is capturing keys (input, confirmation or busy), so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Invoked when the user presses Enter on the highlighted source. */
  readonly onOpenCatalog?: (source: Source) => void;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly sources: readonly Source[] };

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** Built-in sources have no URL; show their name instead. */
function describe(source: Source): string {
  return source.kind === "git" ? source.url : source.name;
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

export function SourcesView({ operations, onCapturingChange, onOpenCatalog }: SourcesViewProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // The highlight follows the source id; the index is only the fallback once that source is gone.
  const [selection, setSelection] = useState<{ readonly id?: string; readonly index: number }>({ index: 0 });
  const [mode, dispatchMode] = useReducer(modeReducer, initialMode);
  // Mirrors the mode synchronously so the shell and later keystrokes never see a stale capturing state.
  const modeRef = useRef<Mode>(initialMode);
  const mounted = useRef(true);
  const [message, setMessage] = useState<Message | undefined>();
  // Git sources marked for a combined refresh; the built-in source can never be marked.
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
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

  const sources = state.status === "ready" ? state.sources : [];
  const found = sources.findIndex((source) => source.id === selection.id);
  const selected = found >= 0 ? found : Math.min(selection.index, Math.max(sources.length - 1, 0));
  const current = sources[selected];
  const gitSources = sources.filter((source): source is GitSource => source.kind === "git");
  const select = (index: number) => {
    const bounded = Math.min(Math.max(index, 0), Math.max(sources.length - 1, 0));
    setSelection({ id: sources[bounded]?.id, index: bounded });
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
  const toggle = (ids: readonly string[]) =>
    setMarked((previous) => {
      const next = new Set(previous);
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });

  const stop = (text: string) => setMessage({ kind: "error", text });

  const startRemoval = async (source: Source) => {
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
        (selection) => selection.source.kind === "external" && "url" in selection.source && source.kind === "git" && selection.source.url === source.url,
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

  useInput((input, key) => {
    const mode = modeRef.current;
    if (mode.kind === "busy") return;
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

    if (key.downArrow || input === "j") {
      select(selected + 1);
    } else if (key.upArrow || input === "k") {
      select(selected - 1);
    } else if (key.return && current) {
      onOpenCatalog?.(current);
    } else if (input === "n") {
      setMessage(undefined);
      typed.current = "";
      dispatch({ type: "input" });
    } else if (input === " " && current) {
      if (current.kind === "builtin") stop("The built-in source cannot be selected for refresh");
      else {
        setMessage(undefined);
        toggle([current.id]);
      }
    } else if (input === "a") {
      const gitIds = sources.filter((source) => source.kind === "git").map((source) => source.id);
      if (gitIds.length === 0) stop("There are no Git sources to select");
      else {
        setMessage(undefined);
        toggle(gitIds);
      }
    } else if (input === "r") {
      const targets = marked.size > 0
        ? gitSources.filter((source) => marked.has(source.id))
        : current?.kind === "git" ? [current] : [];
      if (targets.length > 0) {
        setMessage(undefined);
        dispatch({ type: "confirm", action: "refresh", sources: targets });
      } else if (current?.kind === "builtin") {
        stop("The built-in source cannot be refreshed");
      }
    } else if (input === "d" && current) {
      if (current.kind === "builtin") stop("The built-in source cannot be removed");
      else void startRemoval(current);
    }
  });

  // Sources removed since they were marked no longer count.
  const selectedCount = gitSources.filter((source) => marked.has(source.id)).length;

  if (state.status === "loading") return <Text>Loading sources...</Text>;
  if (state.status === "error") return <Text color="red">Error: {state.message}</Text>;

  return (
    <Box flexDirection="column">
      {sources.length === 0 ? <Text>No sources</Text> : null}
      {sources.length > 0 ? <Text dimColor>{"      "}ID  KIND  URL</Text> : null}
      {sources.map((source, index) => (
        <Text key={source.id} bold={index === selected}>
          {index === selected ? "> " : "  "}
          {source.kind === "git" ? (marked.has(source.id) ? "[x] " : "[ ] ") : "    "}
          {source.id}  {source.kind}  {describe(source)}
        </Text>
      ))}
      {selectedCount > 0 ? <Text>{selectedCount} selected</Text> : null}
      <Prompt mode={mode} />
      {message ? <Text color={message.kind === "error" ? "red" : "green"}>{message.text}</Text> : null}
    </Box>
  );
}

function Prompt({ mode }: { readonly mode: Mode }) {
  if (mode.kind === "input") return <Text>URL: {mode.value}</Text>;
  if (mode.kind === "busy") return <Text>Working...</Text>;
  if (mode.kind === "confirm") {
    const lines = mode.action === "refresh"
      ? mode.sources.map((source) => `refresh Git Source ${source.id} from ${source.url}`)
      : [`remove Git Source ${mode.source.id} from ${describe(mode.source)}`];
    return <Text>{lines.join("\n")}{"\n"}[y/n]</Text>;
  }
  return null;
}
