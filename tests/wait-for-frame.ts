import assert from "node:assert/strict";

import { SPINNER_FRAMES, STATIC_GLYPH } from "../src/tui/working-model.js";

/**
 * Polls an Ink test frame until the predicate holds. Ink renders asynchronously
 * (throttled), so a fixed delay after an update is racy under CPU load.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: RegExp | ((frame: string) => boolean),
  timeoutMs = 5000,
): Promise<string> {
  const matches = typeof predicate === "function" ? predicate : (frame: string) => predicate.test(frame);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = lastFrame() ?? "";
    if (matches(frame)) return frame;
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for frame; last frame:\n${frame}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A frame without box borders and whitespace, so text that wrapped across rows (long paths) still matches. */
export function squash(frame: string): string {
  return frame.replace(/[│╭╮╰╯─\s]/gu, "");
}

const WORKING_LINE = new RegExp(`^[│\\s]*[${[...SPINNER_FRAMES, STATIC_GLYPH].join("")}] \\S[^\\n]*…`, "mu");

/** Whether a line of the frame is a Working line (glyph, label, ellipsis), so some view still has work in flight. */
export function isBusy(frame: string): boolean {
  return WORKING_LINE.test(frame);
}

/**
 * Waits until no view shows a Working line. A view reads and locks state files under the fixture
 * until its Working line clears, so a test that ends before that lets teardown race those
 * operations and `rm` fails with ENOTEMPTY. Call it last when the final frame can still be loading,
 * for example right after switching views.
 *
 * It only sees work a view renders as a Working line. Not covered: work with no Working line (a
 * Catalog that failed to load while its installed-Skills scan runs, App status checks that only
 * read), a wrapped label whose ellipsis lands on another row, and views already unmounted.
 */
export async function waitForSettled(lastFrame: () => string | undefined, timeoutMs = 5000): Promise<string> {
  return waitForFrame(lastFrame, (frame) => !isBusy(frame), timeoutMs);
}
