import { Box, Text, useApp, useStdout } from "ink";
import { useCallback, useRef, useState } from "react";

import { AGENT_DEPOT_PACKAGE_VERSION } from "../project-manifest.js";
import type { SourceOperations } from "../sources.js";
import { CatalogView } from "./catalog-view.js";
import type { TuiEnvironment } from "./environment.js";
import { InstallationsView } from "./installations-view.js";
import { useKeys } from "./keys.js";
import { ProfileView } from "./profile-view.js";
import { SourcesView, sourceRowHints } from "./sources-view.js";
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

type ViewName = "sources" | "catalog" | "installations" | "updates" | "profile";

const TABS: readonly (readonly [ViewName, string])[] = [
  ["sources", "1 Sources"],
  ["catalog", "2 Catalog"],
  ["installations", "3 Installations"],
  ["updates", "4 Updates"],
  ["profile", "5 Import/Export"],
];

/** Compact keys of the views with fixed keys; Sources derives its own from the selected row. */
function hintsOf(view: Exclude<ViewName, "sources">, catalogFocusedOnSource: boolean): string {
  switch (view) {
    case "catalog":
      return `j/k move · Enter expand · space mark · a all · i install · / filter${catalogFocusedOnSource ? " · s all sources" : ""} · q quit`;
    case "installations":
      return "j/k move · Enter expand · space mark · a all · u uninstall · h add hosts · A adopt · q quit";
    case "profile":
      return "e export · i import · q quit";
    case "updates":
      return "j/k move · space mark · a all · Enter preview · r check again · q quit";
  }
}

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
  const [sourcesHints, setSourcesHints] = useState(sourceRowHints(undefined));
  const showView = (next: ViewName) => setView(next);

  useKeys((input) => {
    if (capturingRef.current) return;
    if (input === "q") {
      onExit?.();
      exit();
    } else if (input === "1") showView("sources");
    else if (input === "2") showView("catalog");
    else if (input === "3") showView("installations");
    else if (input === "4") showView("updates");
    else if (input === "5") showView("profile");
  });

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>Agent Depot{AGENT_DEPOT_PACKAGE_VERSION === undefined ? "" : ` v${AGENT_DEPOT_PACKAGE_VERSION}`}</Text>
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
          environment={environment}
          onCapturingChange={onCapturingChange}
          onHintsChange={setSourcesHints}
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
        />
      ) : view === "profile" ? (
        <ProfileView operations={operations} environment={environment} onCapturingChange={onCapturingChange} />
      ) : view === "updates" ? (
        <UpdatesView operations={operations} environment={environment} onCapturingChange={onCapturingChange} />
      ) : (
        <CatalogView
          operations={operations}
          sourceId={catalogSourceId}
          environment={environment}
          onCapturingChange={onCapturingChange}
        />
      )}
      <Text color={theme.muted}>{capturing ? "Enter submit · Esc cancel · y/n confirm · space toggle" : view === "sources" ? sourcesHints : hintsOf(view, catalogSourceId !== undefined)}</Text>
    </Box>
  );
}
