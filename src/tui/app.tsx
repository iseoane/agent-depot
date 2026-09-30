import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useRef, useState } from "react";

import type { SourceOperations } from "../sources.js";
import { CatalogView } from "./catalog-view.js";
import type { TuiEnvironment } from "./environment.js";
import { SourcesView } from "./sources-view.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Home, project and source-access overrides for installs; defaults mirror the CLI. */
  readonly environment?: TuiEnvironment;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
}

type ViewName = "sources" | "catalog";

const HINTS: Record<ViewName, string> = {
  sources: "j/k move  Enter catalog  a add  r refresh  d remove  2 catalog  q quit",
  catalog: "j/k move  / filter  i install  u uninstall  s all sources  1 sources  q quit",
};

export function App({ operations, environment, onExit }: AppProps) {
  const { exit } = useApp();
  const [capturing, setCapturing] = useState(false);
  // Updated synchronously by the views so keys in the same burst never see a stale capturing state.
  const capturingRef = useRef(false);
  const onCapturingChange = useCallback((value: boolean) => {
    capturingRef.current = value;
    setCapturing(value);
  }, []);
  const [view, setView] = useState<ViewName>("sources");
  const [catalogSourceId, setCatalogSourceId] = useState<string | undefined>();

  useInput((input) => {
    if (capturingRef.current) return;
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
          onCapturingChange={onCapturingChange}
          onOpenCatalog={(source) => {
            setCatalogSourceId(source.id);
            setView("catalog");
          }}
        />
      ) : (
        <CatalogView
          operations={operations}
          sourceId={catalogSourceId}
          environment={environment}
          onCapturingChange={onCapturingChange}
        />
      )}
      <Text dimColor>{capturing ? "Enter submit  Esc cancel  y/n confirm  space toggle" : HINTS[view]}</Text>
    </Box>
  );
}
