import { Box, Text, useApp, useInput } from "ink";

import type { SourceOperations } from "../sources.js";
import { SourcesView } from "./sources-view.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
}

export function App({ operations, onExit }: AppProps) {
  const { exit } = useApp();

  useInput((input) => {
    if (input === "q") {
      onExit?.();
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Agent Depot</Text>
      <Text>Sources</Text>
      <SourcesView operations={operations} />
      <Text dimColor>Press q to quit</Text>
    </Box>
  );
}
