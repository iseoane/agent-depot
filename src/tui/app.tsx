import { Box, Text, useApp, useInput } from "ink";

import type { SourceOperations } from "../sources.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
}

export function App({ onExit }: AppProps) {
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
      <Text>Sources (coming soon)</Text>
      <Text dimColor>Press q to quit</Text>
    </Box>
  );
}
