import { render } from "ink";

import type { SourceOperations } from "../sources.js";
import { App } from "./app.js";

/** Renders the TUI and resolves once the user exits it. */
export async function renderTui(operations: SourceOperations): Promise<void> {
  const instance = render(<App operations={operations} />);
  await instance.waitUntilExit();
}
