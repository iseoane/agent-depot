import { render } from "ink";

import { createSourceRefreshSession } from "../source-refresh-session.js";
import type { SourceOperations } from "../sources.js";
import { App } from "./app.js";
import type { TuiEnvironment } from "./environment.js";

/** Renders the TUI and resolves once the user exits it. */
export async function renderTui(operations: SourceOperations, environment?: TuiEnvironment): Promise<void> {
  const refreshSession = createSourceRefreshSession(operations);
  const instance = render(
    <App operations={operations} environment={environment} refreshSession={refreshSession}
      refreshOnStart={environment?.refreshOnStart ?? true} />,
    { alternateScreen: true },
  );
  await instance.waitUntilExit();
  refreshSession.stop();
  // Killing a refresh would leave its Source cache lock behind, so wait for the running ones instead.
  if ([...refreshSession.snapshot().values()].some((state) => state.status === "refreshing")) {
    process.stderr.write("Waiting for the Source refreshes still running to finish…\n");
    await refreshSession.settled();
  }
}
