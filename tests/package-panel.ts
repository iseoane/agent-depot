import assert from "node:assert/strict";

import { waitForFrame } from "./wait-for-frame.js";

/** The rows of the default terminal, which ink-testing-library reports no size for. */
const TERMINAL_ROWS = 24;

/**
 * Pages a Package panel with PgDn until `question` shows and returns every frame visited. The panel
 * offers `y` only once its last row has been shown, so a test must reach the question this way.
 * Each frame must fit the terminal, so a panel that Ink squeezes instead of paging fails here.
 */
export async function pageToQuestion(
  lastFrame: () => string | undefined,
  stdin: { write(data: string): void },
  question: RegExp,
  rows = TERMINAL_ROWS,
): Promise<string[]> {
  const position = (frame: string) => Number(/Review (\d+) of \d+/u.exec(frame)?.[1] ?? Number.NaN);
  const visited: string[] = [];
  for (let page = 0; page < 100; page += 1) {
    const frame = await waitForFrame(lastFrame, /Review \d+ of \d+/u);
    visited.push(frame);
    assert.ok(frame.split("\n").length <= rows, `Package panel exceeded ${rows} rows:\n${frame}`);
    if (question.test(frame)) return visited;
    const current = position(frame);
    stdin.write("\u001B[6~");
    await waitForFrame(lastFrame, (next) => question.test(next) || position(next) > current);
  }
  assert.fail(`Package panel never reached ${String(question)}:\n${lastFrame()}`);
}

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
    const window = /(\d+)–(\d+) of (\d+)/u.exec(frame);
    if (window === null || window[2] === window[3]) return visited;
    stdin.write("\u001B[6~");
    await waitForFrame(lastFrame, (next) => next !== frame);
  }
  assert.fail(`panel never reached its last row:\n${lastFrame()}`);
}

/**
 * Rebuilds the preview rows from paged frames, placing each page's rows by its `from–to of total` window,
 * so a line wrapped across a page boundary is read back whole. Rows are the text between the panel's
 * title and its window indicator.
 */
export function pagedRows(frames: readonly string[]): string[] {
  const rebuilt: string[] = [];
  for (const frame of frames) {
    const lines = frame.split("\n");
    const top = lines.map((line) => line.startsWith("╭")).lastIndexOf(true);
    const window = lines.findIndex((line) => /^│? ?\d+–\d+ of \d+/u.test(line));
    const review = lines.findIndex((line) => /Review \d+ of \d+/u.test(line));
    const end = window >= 0 ? window : review;
    const from = window >= 0 ? Number(/(\d+)–/u.exec(lines[window]!)![1]) - 1 : 0;
    lines.slice(top + 2, end).forEach((line, index) => {
      rebuilt[from + index] = line.replace(/^│ ?/u, "").replace(/ *│$/u, "");
    });
  }
  return rebuilt;
}
