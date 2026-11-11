import assert from "node:assert/strict";

import { squash, waitForFrame } from "./wait-for-frame.js";

/** The `from–to of total` window of the footer, read across wrapped rows. */
const WINDOW = /(\d+)–(\d+)of(\d+)/u;
/** The first footer row: reading progress or `read ✓`. */
const FOOTER = /read (✓|[█░]* ?\d+%)/u;

/** The rows of the default terminal, which ink-testing-library reports no size for. */
const TERMINAL_ROWS = 24;

/** Presses PgDn until the window reaches the last row (or the content fits) and returns every frame visited. */
export async function pageToEnd(
  lastFrame: () => string | undefined,
  stdin: { write(data: string): void },
  rows = TERMINAL_ROWS,
): Promise<string[]> {
  const visited: string[] = [];
  for (let page = 0; page < 100; page += 1) {
    const frame = await waitForFrame(lastFrame, /Review \d+ of \d+/u);
    visited.push(frame);
    assert.ok(frame.split("\n").length <= rows, `panel exceeded ${rows} rows:\n${frame}`);
    const window = WINDOW.exec(squash(frame));
    if (window === null || window[2] === window[3]) return visited;
    stdin.write("\u001B[6~");
    await waitForFrame(lastFrame, (next) => next !== frame);
  }
  assert.fail(`panel never reached its last row:\n${lastFrame()}`);
}

/**
 * Rebuilds the preview rows from paged frames, placing each page's rows by its `from–to of total` window,
 * so a line wrapped across a page boundary is read back whole. Rows are the text between the panel's
 * title and its footer.
 */
export function pagedRows(frames: readonly string[]): string[] {
  const rebuilt: string[] = [];
  for (const frame of frames) {
    const lines = frame.split("\n");
    const top = lines.map((line) => line.startsWith("╭")).lastIndexOf(true);
    const end = lines.findIndex((line) => FOOTER.test(line));
    const window = WINDOW.exec(squash(lines.slice(end).join("")));
    const from = window === null ? 0 : Number(window[1]) - 1;
    lines.slice(top + 2, end).forEach((line, index) => {
      rebuilt[from + index] = line.replace(/^│ ?/u, "").replace(/ *│$/u, "");
    });
  }
  return rebuilt;
}
