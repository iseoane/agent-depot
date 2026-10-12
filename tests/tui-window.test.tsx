import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { formatHeaderTabs, headerTabRowCount } from "../src/tui/header-layout.js";
import { previewViewport } from "../src/tui/preview-window.js";
import { computeWindow, pageStep } from "../src/tui/window.js";
import { waitForFrame } from "./wait-for-frame.js";

test("80-column tab layout keeps every numbered destination on one line", () => {
  const tabs = formatHeaderTabs("catalog", 76);
  assert.equal(headerTabRowCount(76), 1);
  for (const destination of ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"]) {
    assert.ok(tabs.includes(destination), `80-column tab row lost ${destination}: ${tabs}`);
  }
});

test("40-column tab layout wraps without dropping any numbered destination", () => {
  const tabs = formatHeaderTabs("catalog", 36);
  assert.equal(headerTabRowCount(36), 3);
  for (const destination of ["[1] Sources", "[2] Catalog", "[3] Installations", "[4] Updates", "[5] Profile"]) {
    assert.ok(tabs.includes(destination), `40-column tab rows lost ${destination}:\n${tabs}`);
  }
});

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

test("preview confirmation follows the rendered physical rows at the viewport end", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `row ${index}`);
  const middle = previewViewport(lines, 6, 15, 80);
  assert.deepEqual(middle, {
    rows: ["row 4", "row 5", "row 6", "row 7"],
    sourceLines: [4, 5, 6, 7],
    start: 4,
    end: 8,
    total: 10,
    cursor: 6,
    height: 4,
    reachedEnd: false,
  });
  const final = previewViewport(lines, 9, 15, 80);
  assert.deepEqual(final.rows, ["row 6", "row 7", "row 8", "row 9"]);
  assert.equal(final.reachedEnd, true);
});

test("preview viewport wraps complete long terms and responds to the latest terminal dimensions", () => {
  const line = `Working directory: ${"/resolved/full/path/".repeat(8)}`;
  const wide = previewViewport([line], 0, 24, 80);
  const narrow = previewViewport([line], 0, 17, 40);
  assert.equal(wide.total, 3);
  assert.equal(narrow.total, 5);
  const lastPage = previewViewport([line], 4, 17, 40);
  assert.equal(lastPage.rows.join(""), line);
  assert.equal(lastPage.reachedEnd, true);
  assert.equal(previewViewport(["界".repeat(19)], 0, 17, 40).total, 2);
  assert.ok(lastPage.height < wide.height);
});

test("preview chrome wraps long approval names into the shared viewport geometry", () => {
  const name = `approved-${"long-recipe-name-".repeat(4)}`;
  const chrome = {
    title: "Recipe approval · does not install",
    questions: [`Approve ${name}? y/n · recipe approval does not install the App.`, "Scroll to end before y; n cancels."],
  };
  const lines = Array.from({ length: 20 }, (_, index) => `danger term ${index}`);
  const wide = previewViewport(lines, 19, 24, 80, chrome);
  const narrow = previewViewport(lines, 19, 17, 40, chrome);
  assert.equal(wide.height, 12);
  assert.equal(narrow.height, 1);
  assert.equal(wide.rows.at(-1), "danger term 19");
  assert.equal(narrow.rows.at(-1), "danger term 19");
  assert.equal(wide.reachedEnd, true);
  assert.equal(narrow.reachedEnd, true);
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
  const top = await waitForFrame(lastFrame, /1–5 of 30/);
  assert.equal(top.split("\n").filter((line) => /git:/.test(line)).length, 5);
  assert.match(top, /builtin:agent-depot\s+skills\s+included/);
  assert.match(selectedLine(top), /git:0+\b/);
  // One key at a time: each keystroke acts on the rendered selection.
  for (let step = 1; step <= 14; step += 1) {
    stdin.write(DOWN);
    await waitForFrame(lastFrame, (frame) => new RegExp(`git:0*${step}\\b`).test(selectedLine(frame)));
  }
  const middle = await waitForFrame(lastFrame, (frame) => /git:0+14\b/.test(selectedLine(frame)));
  assert.match(middle, /\d+–\d+ of 30/);
  assert.equal(middle.split("\n").filter((line) => /git:/.test(line)).length, 5);
  for (const expected of [19, 24, 29]) {
    stdin.write(PAGE_DOWN);
    await waitForFrame(lastFrame, (frame) => new RegExp(`git:0*${expected}\\b`).test(selectedLine(frame)));
  }
  const end = await waitForFrame(lastFrame, /26–30 of 30/);
  assert.match(selectedLine(end), /git:0+29\b/);
  stdin.write(PAGE_UP);
  await waitForFrame(lastFrame, (frame) => /git:0+24\b/.test(selectedLine(frame)));
  unmount();
});
