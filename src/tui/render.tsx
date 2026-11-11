import { render } from "ink";

import { createSourceRefreshSession } from "../source-refresh-session.js";
import type { SourceOperations } from "../sources.js";
import { App } from "./app.js";
import type { TuiEnvironment } from "./environment.js";

/** Renders the TUI and resolves once the user exits it. */
export async function renderTui(operations: SourceOperations, environment?: TuiEnvironment): Promise<void> {
  const refreshSession = createSourceRefreshSession(operations);
  const instance = render(
    <App operations={operations} environment={environment} refreshSession={refreshSession} refreshOnStart />,
    { alternateScreen: true },
  );
  await instance.waitUntilExit();
  // Killing a refresh would leave its Source cache lock behind, so the process waits for it instead.
  if ([...refreshSession.snapshot().values()].some((state) => state.status === "refreshing")) {
    process.stderr.write("Waiting for background Source refreshes to finish (up to 60 s)…\n");
  }
}
