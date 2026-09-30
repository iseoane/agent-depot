import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { computeWindow, pageStep } from "../src/tui/window.js";
import { waitForFrame } from "./wait-for-frame.js";

test("computeWindow shows everything without an indicator when the list fits", () => {
  assert.deepEqual(computeWindow(5, 2, 10), { start: 0, end: 5, indicator: undefined });
  assert.deepEqual(computeWindow(0, 0, 10), { start: 0, end: 0, indicator: undefined });
});

test("computeWindow keeps the selection visible at the top, middle and end with a correct indicator", () => {
  assert.deepEqual(computeWindow(84, 0, 19), { start: 0, end: 19, indicator: "1–19 of 84" });
  const middle = computeWindow(84, 40, 19);
  assert.ok(middle.start <= 40 && 40 < middle.end);
  assert.equal(middle.end - middle.start, 19);
  assert.equal(middle.indicator, `${middle.start + 1}–${middle.end} of 84`);
  assert.deepEqual(computeWindow(84, 83, 19), { start: 65, end: 84, indicator: "66–84 of 84" });
});

test("computeWindow never renders less than one row and clamps an out-of-range selection", () => {
  assert.deepEqual(computeWindow(10, 3, 0), { start: 3, end: 4, indicator: "4–4 of 10" });
  const clamped = computeWindow(10, 99, 4);
  assert.equal(clamped.end, 10);
});

test("pageStep is the window height, at least one row", () => {
  assert.equal(pageStep(12), 12);
  assert.equal(pageStep(0), 1);
});

const gitSources: readonly Source[] = [
  BUILT_IN_SOURCE,
  ...Array.from({ length: 30 }, (_, n): Source => ({
    id: `git:${String(n).padStart(24, "0")}`,
    kind: "git",
    url: `https://example.com/repo-${String(n).padStart(2, "0")}.git`,
  })),
];

function operationsFor(sources: readonly Source[]): SourceOperations {
  return {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return sources;
    },
    async refreshSource() {
      throw new Error("unused");
    },
    async selectSources() {
      return [];
    },
  };
}

const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const PAGE_UP = "\u001B[5~";

function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.startsWith("> ")) ?? "";
}

test("SourcesView renders only the rows that fit and keeps the highlighted row visible", async () => {
  const { lastFrame, stdin, unmount } = render(<SourcesView operations={operationsFor(gitSources)} listHeight={5} />);
  const top = await waitForFrame(lastFrame, /1–5 of 31/);
  assert.equal(top.split("\n").filter((line) => /builtin|git:/.test(line)).length, 5);
  assert.match(selectedLine(top), /builtin:agent-depot/);
  // One key at a time: each keystroke acts on the rendered selection.
  for (let step = 1; step <= 15; step += 1) {
    stdin.write(DOWN);
    await waitForFrame(lastFrame, (frame) => new RegExp(`git:0*${step - 1}\\b`).test(selectedLine(frame)));
  }
  const middle = await waitForFrame(lastFrame, (frame) => /git:0+14\b/.test(selectedLine(frame)));
  assert.match(middle, /\d+–\d+ of 31/);
  assert.equal(middle.split("\n").filter((line) => /git:/.test(line)).length, 5);
  for (const expected of [19, 24, 29]) {
    stdin.write(PAGE_DOWN);
    await waitForFrame(lastFrame, (frame) => new RegExp(`git:0*${expected}\\b`).test(selectedLine(frame)));
  }
  const end = await waitForFrame(lastFrame, /27–31 of 31/);
  assert.match(selectedLine(end), /git:0+29\b/);
  stdin.write(PAGE_UP);
  await waitForFrame(lastFrame, (frame) => /git:0+24\b/.test(selectedLine(frame)));
  unmount();
});
