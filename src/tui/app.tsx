import { Box, Text, useApp, useWindowSize } from "ink";
import { useCallback, useRef, useState } from "react";

import { AGENT_DEPOT_PACKAGE_VERSION } from "../project-manifest.js";
import type { SourceOperations } from "../sources.js";
import { CatalogView } from "./catalog-view.js";
import type { TuiEnvironment } from "./environment.js";
import { InstallationsView } from "./installations-view.js";
import { formatHeaderTabs, TABS, type ViewName } from "./header-layout.js";
import { useKeys } from "./keys.js";
import { ProfileView } from "./profile-view.js";
import { SourcesView, sourceRowHints } from "./sources-view.js";
import { theme } from "./theme.js";
import { UpdatesView } from "./updates-view.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Home, project and source-access overrides for installs; defaults mirror the CLI. */
  readonly environment?: TuiEnvironment;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
}

/** Sources derives its own hints from the selected row, so it is excluded here. */
function hintsOf(view: Exclude<ViewName, "sources">, catalogFocusedOnSource: boolean): string {
  switch (view) {
    case "catalog":
      return `j/k move · Enter expand · space mark · a repo · i install · / filter${catalogFocusedOnSource ? " · s all sources" : ""} · q quit`;
    case "installations":
      return "j/k move · Enter expand · space mark · a all · u uninstall · h add hosts · A adopt · q quit";
    case "profile":
      return "e export · i import · q quit";
    case "updates":
      return "j/k move · space mark · a all · Enter preview · r check again · q quit";
  }
}

function Header({ view, columns }: { readonly view: ViewName; readonly columns: number }) {
  const innerWidth = Math.max(columns - 4, 1);
  return (
    <Box borderStyle="round" borderColor={theme.group} paddingX={1} flexDirection="column" width={columns}>
      <Box width={innerWidth} justifyContent="space-between">
        <Text bold>AGENT DEPOT</Text>
        {AGENT_DEPOT_PACKAGE_VERSION === undefined ? null : <Text>v{AGENT_DEPOT_PACKAGE_VERSION}</Text>}
      </Box>
      <Text wrap="truncate-end">{formatHeaderTabs(view, innerWidth)}</Text>
    </Box>
  );
}

export function App({ operations, environment, onExit }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
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

  useKeys((input, key) => {
    if (capturingRef.current) return;
    if (key.tab) {
      const current = TABS.findIndex(([name]) => name === view);
      const direction = key.shift ? -1 : 1;
      showView(TABS[(current + direction + TABS.length) % TABS.length]![0]);
    } else if (input === "q") {
      onExit?.();
      exit();
    } else if (input === "1") showView("sources");
    else if (input === "2") showView("catalog");
    else if (input === "3") showView("installations");
    else if (input === "4") showView("updates");
    else if (input === "5") showView("profile");
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Header view={view} columns={columns} />
      <Box flexDirection="column" flexGrow={1}>
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
      </Box>
      <Text color={theme.muted}>{capturing
        ? columns < 64 ? "Enter submit · Esc cancel" : "Enter submit · Esc cancel · y/n confirm · space toggle"
        : view === "sources" ? sourcesHints : hintsOf(view, catalogSourceId !== undefined)}</Text>
    </Box>
  );
}
