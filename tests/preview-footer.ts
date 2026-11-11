import assert from "node:assert/strict";

import { waitForFrame } from "./wait-for-frame.js";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/** The terminal sizes whose key handling and rendering must agree on where a preview ends. */
export const PREVIEW_SIZES: readonly TerminalSize[] = [
  { columns: 40, rows: 17 },
  { columns: 80, rows: 24 },
  { columns: 110, rows: 40 },
];

interface PreviewView {
  readonly lastFrame: () => string | undefined;
  readonly stdin: { write(data: string): void };
  readonly stdout: NodeJS.EventEmitter;
}

/** The rows inside the open panel, without its border and padding. */
export const panelRows = (frame: string) => frame.split("\n").filter(row => row.startsWith("│ ")).map(row => row.slice(2).replace(/ *│$/u, ""));

export function resizeTerminal(view: PreviewView, size: TerminalSize): void {
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: size.rows });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: size.columns });
  view.stdout.emit("resize");
}

const READ_DONE = /read ✓/u;
const READING = /read [█░]* ?\d+%/u;
const REVIEW = /Review (\d+) of (\d+)/u;

/** The frame with wrapped panel rows joined, so a footer row cut at a narrow width reads whole. */
const unwrapped = (frame: string) => frame.replace(/ *│\n│ /gu, "");

async function waitUntil(condition: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * Walks an open preview one row at a time. While the footer still shows reading progress, the `[y]`
 * action is listed but `y` does nothing; once the footer reads ✓, `y` acts. Pressing `y` on every
 * row up to the transition proves the key handler and the render agree on where the preview ends.
 */
export async function confirmAtEnd(view: PreviewView, rows: number, action: RegExp, acted: () => boolean): Promise<string> {
  let frame = await waitForFrame(view.lastFrame, candidate => READ_DONE.test(candidate) || READING.test(candidate));
  for (let step = 0; step < 500 && !READ_DONE.test(frame); step += 1) {
    assert.match(unwrapped(frame), action, `the footer does not name what y does:\n${frame}`);
    assert.ok(frame.split("\n").length <= rows, `the preview exceeded ${rows} rows:\n${frame}`);
    const position = REVIEW.exec(frame)?.[1];
    view.stdin.write("y");
    view.stdin.write("j");
    frame = await waitForFrame(view.lastFrame, candidate => REVIEW.exec(candidate)?.[1] !== position);
    assert.equal(acted(), false, `y acted before the footer read ✓:\n${frame}`);
    assert.ok(READING.test(frame) || READ_DONE.test(frame), `y left the preview before the footer read ✓:\n${frame}`);
  }
  assert.match(frame, READ_DONE);
  assert.match(unwrapped(frame), action, `the final footer does not name what y does:\n${frame}`);
  assert.ok(frame.split("\n").length <= rows, `the preview exceeded ${rows} rows:\n${frame}`);
  view.stdin.write("y");
  await waitUntil(acted, `y did nothing once the footer read ✓:\n${view.lastFrame()}`);
  return frame;
}
