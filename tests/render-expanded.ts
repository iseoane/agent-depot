import type { ReactElement } from "react";
import { render } from "ink-testing-library";
import { waitForFrame } from "./wait-for-frame.js";

/** Action tests explicitly open the first nonempty group before exercising its children. */
export async function renderExpanded(element: ReactElement): Promise<ReturnType<typeof render>> {
  const view = render(element);
  const frame = await waitForFrame(view.lastFrame, (text) => text.length > 0 && !text.startsWith("Loading"));
  const target = frame.split("\n").find((line) => line.includes("▸"))?.trim().replace(/^>\s*/u, "");
  if (!target) return view;
  const selected = () => (view.lastFrame() ?? "").split("\n").find((line) => line.startsWith("> "))?.slice(2).trim();
  let moves = 0;
  while (selected() !== target) {
    if (moves++ > 20) throw new Error(`Cannot highlight ${target}: ${view.lastFrame()}`);
    const before = view.lastFrame();
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, (text) => text !== before);
  }
  const before = view.lastFrame();
  view.stdin.write("\u001b[C");
  await waitForFrame(view.lastFrame, (text) => text !== before);
  while (moves-- > 0) {
    const before = view.lastFrame();
    view.stdin.write("k");
    await waitForFrame(view.lastFrame, (text) => text !== before);
  }
  return view;
}
