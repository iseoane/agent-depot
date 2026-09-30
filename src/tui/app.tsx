import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";

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
  const [capturing, setCapturing] = useState(false);

  useInput((input) => {
    if (input === "q" && !capturing) {
      onExit?.();
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Agent Depot</Text>
      <Text>Sources</Text>
      <SourcesView operations={operations} onCapturingChange={setCapturing} />
      <Text dimColor>
        {capturing ? "Enter submit  Esc cancel  y/n confirm" : "j/k move  a add  r refresh  d remove  q quit"}
      </Text>
    </Box>
  );
}
