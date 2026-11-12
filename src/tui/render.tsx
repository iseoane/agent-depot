import { render } from "ink";

import { createSourceRefreshSession, type SourceRefreshSession } from "../source-refresh-session.js";
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
  await finishRunningRefreshes(refreshSession, (message) => process.stderr.write(message));
}

/** Drops the queued refreshes and waits for the running ones, telling the user only when it has to wait. */
export async function finishRunningRefreshes(refreshSession: SourceRefreshSession, write: (message: string) => void): Promise<void> {
  refreshSession.stop();
  // Killing a refresh would leave its Source cache lock behind, so wait for the running ones instead.
  if ([...refreshSession.snapshot().values()].some((state) => state.status === "refreshing")) {
    write("Waiting for the Source refreshes still running to finish…\n");
    await refreshSession.settled();
  }
}
