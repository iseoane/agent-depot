import { render } from "ink";

import type { SourceOperations } from "../sources.js";
import { App } from "./app.js";
import type { TuiEnvironment } from "./environment.js";

/** Renders the TUI and resolves once the user exits it. */
export async function renderTui(operations: SourceOperations, environment?: TuiEnvironment): Promise<void> {
  const instance = render(<App operations={operations} environment={environment} />, { alternateScreen: true });
  await instance.waitUntilExit();
}
