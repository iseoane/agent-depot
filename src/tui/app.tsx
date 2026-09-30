import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useRef, useState } from "react";

import type { SourceOperations } from "../sources.js";
import type { CatalogFocus } from "./catalog-actions.js";
import { CatalogView } from "./catalog-view.js";
import type { TuiEnvironment } from "./environment.js";
import { InstallationsView } from "./installations-view.js";
import { SourcesView } from "./sources-view.js";
import { separatorLine, theme } from "./theme.js";
import { UpdatesView } from "./updates-view.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Home, project and source-access overrides for installs; defaults mirror the CLI. */
  readonly environment?: TuiEnvironment;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
}

type ViewName = "sources" | "catalog" | "installations" | "updates";

const TABS: readonly (readonly [ViewName, string])[] = [
  ["sources", "1 Sources"],
  ["catalog", "2 Catalog"],
  ["installations", "3 Installations"],
  ["updates", "4 Updates"],
];

const HINTS: Record<ViewName, string> = {
  sources: "j/k move  PgUp/PgDn page  space select  a all git  Enter catalog  n add  r refresh  d remove  2 catalog  3 installations  4 updates  q quit",
  catalog: "j/k move  / filter  i install  u uninstall  s all sources  1 sources  3 installations  4 updates  q quit",
  installations: "j/k move  PgUp/PgDn page  Enter/right expand  left collapse  A adopt  u uninstall  i hosts  1 sources  2 catalog  4 updates  q quit",
  updates: "j/k move  space toggle  a all  Enter preview  p project  g user-global  r check  1 sources  2 catalog  3 installations  q quit",
};

export function App({ operations, environment, onExit }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [capturing, setCapturing] = useState(false);
  // Updated synchronously by the views so keys in the same burst never see a stale capturing state.
  const capturingRef = useRef(false);
  const onCapturingChange = useCallback((value: boolean) => {
    capturingRef.current = value;
    setCapturing(value);
  }, []);
  const [view, setView] = useState<ViewName>("sources");
  const [catalogSourceId, setCatalogSourceId] = useState<string | undefined>();
  // Set when the Installations view hands a Skill over to the Catalog flows; cleared on manual navigation.
  const [catalogFocus, setCatalogFocus] = useState<CatalogFocus | undefined>();
  const showView = (next: ViewName) => {
    setCatalogFocus(undefined);
    setView(next);
  };

  useInput((input) => {
    if (capturingRef.current) return;
    if (input === "q") {
      onExit?.();
      exit();
    } else if (input === "1") showView("sources");
    else if (input === "2") showView("catalog");
    else if (input === "3") showView("installations");
    else if (input === "4") showView("updates");
  });

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>Agent Depot</Text>
      <Text>
        {TABS.map(([name, label], position) => (
          <Text key={name} color={view === name ? theme.accent : theme.inactive} bold={view === name}>
            {position > 0 ? " " : ""}{view === name ? `[${label}]` : ` ${label} `}
          </Text>
        ))}
      </Text>
      <Text color={theme.muted}>{separatorLine(stdout.columns)}</Text>
      {view === "sources" ? (
        <SourcesView
          operations={operations}
          onCapturingChange={onCapturingChange}
          onOpenCatalog={(source) => {
            setCatalogSourceId(source.id);
            setView("catalog");
          }}
        />
      ) : view === "installations" ? (
        <InstallationsView
          operations={operations}
          environment={environment}
          onCapturingChange={onCapturingChange}
          onOpenCatalog={(focus) => {
            setCatalogSourceId(focus.sourceId);
            setCatalogFocus(focus);
            setView("catalog");
          }}
        />
      ) : view === "updates" ? (
        <UpdatesView operations={operations} environment={environment} onCapturingChange={onCapturingChange} />
      ) : (
        <CatalogView
          operations={operations}
          sourceId={catalogSourceId}
          environment={environment}
          focus={catalogFocus}
          onCapturingChange={onCapturingChange}
        />
      )}
      <Text color={theme.muted}>{capturing ? "Enter submit  Esc cancel  y/n confirm  space toggle" : HINTS[view]}</Text>
    </Box>
  );
}
