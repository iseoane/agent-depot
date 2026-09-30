import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

import type { Source, SourceOperations } from "../sources.js";

export interface SourcesViewProps {
  readonly operations: SourceOperations;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly sources: readonly Source[] };

/** Built-in sources have no URL; show their name instead. */
function describe(source: Source): string {
  return source.kind === "git" ? source.url : source.name;
}

export function SourcesView({ operations }: SourcesViewProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    operations.listSources().then(
      (sources) => {
        if (!cancelled) setState({ status: "ready", sources });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [operations]);

  const count = state.status === "ready" ? state.sources.length : 0;

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelected((current) => Math.min(current + 1, Math.max(count - 1, 0)));
    } else if (key.upArrow || input === "k") {
      setSelected((current) => Math.max(current - 1, 0));
    }
  });

  if (state.status === "loading") return <Text>Loading sources...</Text>;
  if (state.status === "error") return <Text color="red">Error: {state.message}</Text>;
  if (state.sources.length === 0) return <Text>No sources</Text>;

  return (
    <Box flexDirection="column">
      {state.sources.map((source, index) => (
        <Text key={source.id} bold={index === selected}>
          {index === selected ? "> " : "  "}
          {source.id}  {source.kind}  {describe(source)}
        </Text>
      ))}
    </Box>
  );
}
