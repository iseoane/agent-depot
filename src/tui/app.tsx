import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";

import type { SourceOperations } from "../sources.js";
import { CatalogView } from "./catalog-view.js";
import { SourcesView } from "./sources-view.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
}

type ViewName = "sources" | "catalog";

const HINTS: Record<ViewName, string> = {
  sources: "j/k move  Enter catalog  a add  r refresh  d remove  2 catalog  q quit",
  catalog: "j/k move  / filter  s all sources  1 sources  q quit",
};

export function App({ operations, onExit }: AppProps) {
  const { exit } = useApp();
  const [capturing, setCapturing] = useState(false);
  const [view, setView] = useState<ViewName>("sources");
  const [catalogSourceId, setCatalogSourceId] = useState<string | undefined>();

  useInput((input) => {
    if (capturing) return;
    if (input === "q") {
      onExit?.();
      exit();
    } else if (input === "1") setView("sources");
    else if (input === "2") setView("catalog");
  });

  return (
    <Box flexDirection="column">
      <Text bold>Agent Depot</Text>
      <Text>
        {view === "sources" ? "[1 Sources]" : " 1 Sources "} {view === "catalog" ? "[2 Catalog]" : " 2 Catalog "}
      </Text>
      {view === "sources" ? (
        <SourcesView
          operations={operations}
          onCapturingChange={setCapturing}
          onOpenCatalog={(source) => {
            setCatalogSourceId(source.id);
            setView("catalog");
          }}
        />
      ) : (
        <CatalogView operations={operations} sourceId={catalogSourceId} onCapturingChange={setCapturing} />
      )}
      <Text dimColor>{capturing ? "Enter submit  Esc cancel  y/n confirm" : HINTS[view]}</Text>
    </Box>
  );
}
