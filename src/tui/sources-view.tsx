import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { Source, SourceOperations } from "../sources.js";
import { initialMode, modeReducer, type Mode } from "./sources-mode.js";

export interface SourcesViewProps {
  readonly operations: SourceOperations;
  /** Reports whether the view is capturing keys (input, confirmation or busy), so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SourcesView({ operations, onCapturingChange }: SourcesViewProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  const [mode, dispatch] = useReducer(modeReducer, initialMode);
  const [message, setMessage] = useState<Message | undefined>();
  // Mirrors the typed URL synchronously so keystrokes delivered in one burst are not lost to stale closures.
  const typed = useRef("");

  const reload = useCallback(async () => {
    try {
      const sources = await operations.listSources();
      setState({ status: "ready", sources });
      setSelected((current) => Math.min(current, Math.max(sources.length - 1, 0)));
    } catch (error) {
      setState({ status: "error", message: errorText(error) });
    }
  }, [operations]);

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

  useEffect(() => {
    onCapturingChange?.(mode.kind !== "browse");
  }, [mode.kind, onCapturingChange]);

  const sources = state.status === "ready" ? state.sources : [];
  const current = sources[selected];

  /** Runs a mutating action in the busy mode, reports its outcome and reloads the list. */
  const run = async (action: () => Promise<string>) => {
    dispatch({ type: "busy" });
    setMessage(undefined);
    try {
      setMessage({ kind: "ok", text: await action() });
    } catch (error) {
      setMessage({ kind: "error", text: `Error: ${errorText(error)}` });
    }
    await reload();
    dispatch({ type: "done" });
  };

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
      stop(`Error: ${errorText(error)}`);
      dispatch({ type: "done" });
    }
  };

  useInput((input, key) => {
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
        const { action, source } = mode;
        void run(async () => {
          if (action === "refresh") {
            return `Refreshed Git Source: ${(await operations.refreshSource(source.id)).id}`;
          }
          await operations.removeGitSource?.(source.id);
          return `Removed Git Source: ${source.id}`;
        });
      } else if (input === "n" || key.escape) dispatch({ type: "done" });
      return;
    }

    if (key.downArrow || input === "j") {
      setSelected((index) => Math.min(index + 1, Math.max(sources.length - 1, 0)));
    } else if (key.upArrow || input === "k") {
      setSelected((index) => Math.max(index - 1, 0));
    } else if (input === "a") {
      setMessage(undefined);
      typed.current = "";
      dispatch({ type: "input" });
    } else if ((input === "r" || input === "d") && current) {
      if (current.kind === "builtin") {
        stop(`The built-in source cannot be ${input === "r" ? "refreshed" : "removed"}`);
      } else if (input === "r") {
        setMessage(undefined);
        dispatch({ type: "confirm", action: "refresh", source: current });
      } else {
        void startRemoval(current);
      }
    }
  });

  if (state.status === "loading") return <Text>Loading sources...</Text>;
  if (state.status === "error") return <Text color="red">Error: {state.message}</Text>;

  return (
    <Box flexDirection="column">
      {sources.length === 0 ? <Text>No sources</Text> : null}
      {sources.map((source, index) => (
        <Text key={source.id} bold={index === selected}>
          {index === selected ? "> " : "  "}
          {source.id}  {source.kind}  {describe(source)}
        </Text>
      ))}
      <Prompt mode={mode} />
      {message ? <Text color={message.kind === "error" ? "red" : "green"}>{message.text}</Text> : null}
    </Box>
  );
}

function Prompt({ mode }: { readonly mode: Mode }) {
  if (mode.kind === "input") return <Text>URL: {mode.value}</Text>;
  if (mode.kind === "busy") return <Text>Working...</Text>;
  if (mode.kind === "confirm") {
    const url = mode.source.kind === "git" ? mode.source.url : mode.source.name;
    return <Text>{mode.action} Git Source {mode.source.id} from {url}? [y/n]</Text>;
  }
  return null;
}
