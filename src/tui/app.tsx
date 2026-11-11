import { Box, Text, useApp, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AGENT_DEPOT_PACKAGE_VERSION } from "../project-manifest.js";
import { withRefreshSession, type SourceRefreshSession } from "../source-refresh-session.js";
import type { SourceOperations } from "../sources.js";
import { CatalogView } from "./catalog-view.js";
import type { TuiEnvironment } from "./environment.js";
import { InstallationsView } from "./installations-view.js";
import { headerTabRows, TABS, type ViewName } from "./header-layout.js";
import { useKeys } from "./keys.js";
import { ProfileView } from "./profile-view.js";
import { SourcesView, sourceRowHints } from "./sources-view.js";
import { theme } from "./theme.js";
import { UpdatesView } from "./updates-view.js";
import { createViewRetention, invalidateRetention } from "./view-retention.js";

export interface AppProps {
  /** Source operations the views call directly; injectable for tests. */
  readonly operations: SourceOperations;
  /** Home, project and source-access overrides for installs; defaults mirror the CLI. */
  readonly environment?: TuiEnvironment;
  /** Invoked once when the user asks to quit. */
  readonly onExit?: () => void;
  /** Shared by every view so refreshes are deduplicated, reused and shown in Sources. */
  readonly refreshSession?: SourceRefreshSession;
  /** Refreshes the registered Git Sources in the background once mounted; opt-in so tests stay offline. */
  readonly refreshOnStart?: boolean;
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
      return "j/k move · space mark · a all · Enter expand · u update · r check again · q quit";
  }
}

export function Header({ view, columns }: { readonly view: ViewName; readonly columns: number }) {
  const innerWidth = Math.max(columns - 4, 1);
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column" width={columns}>
      <Box width={innerWidth} justifyContent="space-between">
        <Text color={theme.accent} bold>AGENT DEPOT</Text>
        {AGENT_DEPOT_PACKAGE_VERSION === undefined ? null : <Text color={theme.value}>v{AGENT_DEPOT_PACKAGE_VERSION}</Text>}
      </Box>
      <Box flexDirection="column">
        {headerTabRows(innerWidth).map((row, rowIndex) => (
          <Text key={rowIndex} wrap="truncate-end">
            {row.map(([name, label], tabIndex) => (
              <Text key={name} color={view === name ? theme.accent : theme.inactive}>
                {tabIndex === 0 ? "" : "  "}{view === name ? "▶ " : ""}{label}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function App({ operations: plainOperations, environment: plainEnvironment, onExit, refreshSession, refreshOnStart }: AppProps) {
  // Memoized: views reload whenever the operations they receive change identity.
  const operations = useMemo(
    () => refreshSession === undefined ? plainOperations : withRefreshSession(plainOperations, refreshSession),
    [plainOperations, refreshSession],
  );
  // Package previews refresh through the same session, so they reuse and show the same refreshes.
  const environment = useMemo<TuiEnvironment | undefined>(
    () => refreshSession === undefined ? plainEnvironment : {
      ...plainEnvironment,
      refreshSession,
      ...(plainEnvironment?.packages !== undefined ? {} : {
        packagesEnvironment: { ...plainEnvironment?.packagesEnvironment, sourceOperations: operations },
      }),
    },
    [plainEnvironment, refreshSession, operations],
  );
  useEffect(() => {
    if (!refreshOnStart || refreshSession === undefined) return;
    // D3 (I0031): only registered Git Sources; the built-in Source is never refreshed.
    plainOperations.listSources().then(
      (sources) => refreshSession.refreshInBackground(sources.filter((source) => source.kind === "git")),
      () => undefined,
    );
  }, [plainOperations, refreshSession, refreshOnStart]);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [capturing, setCapturing] = useState(false);
  // Updated synchronously by the views so keys in the same burst never see a stale capturing state.
  const capturingRef = useRef(false);
  const [view, setView] = useState<ViewName>("sources");
  // Catalog and Installations unmount on a tab change; this keeps what they loaded, for display only.
  const [retention] = useState(createViewRetention);
  // Sources, Updates and Profile may change what the retained data describes. Any mode they capture
  // keys for (add, refresh, approve, confirm, import) can, so leaving after one drops the retention.
  const viewRef = useRef<ViewName>(view);
  const touched = useRef(false);
  const onCapturingChange = useCallback((value: boolean) => {
    capturingRef.current = value;
    if (value && viewRef.current !== "catalog" && viewRef.current !== "installations") touched.current = true;
    setCapturing(value);
  }, []);
  const [catalogSourceId, setCatalogSourceId] = useState<string | undefined>();
  const [sourcesHints, setSourcesHints] = useState(sourceRowHints(undefined));
  const showView = (next: ViewName) => {
    if (touched.current) invalidateRetention(retention);
    touched.current = false;
    viewRef.current = next;
    setView(next);
  };

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
            refreshSession={refreshSession}
            onOpenCatalog={(source) => {
              setCatalogSourceId(source.id);
              showView("catalog");
            }}
          />
        ) : view === "installations" ? (
          <InstallationsView
            operations={operations}
            environment={environment}
            onCapturingChange={onCapturingChange}
            retention={retention}
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
            retention={retention}
          />
        )}
      </Box>
      <Text color={theme.muted}>{capturing
        ? columns < 64 ? "Enter submit · Esc cancel" : "Enter submit · Esc cancel · y/n confirm · space toggle"
        : view === "sources" ? sourcesHints : hintsOf(view, catalogSourceId !== undefined)}</Text>
    </Box>
  );
}
