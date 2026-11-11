import assert from "node:assert/strict";
import { test } from "node:test";

import { Text } from "ink";
import { render } from "ink-testing-library";

import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { formatHeaderTabs, headerTabRowCount } from "../src/tui/header-layout.js";
import { previewViewport, type PreviewChrome } from "../src/tui/preview-window.js";
import { computeWindow, pageStep, useListHeight } from "../src/tui/window.js";
import { waitForFrame } from "./wait-for-frame.js";

function ListHeightProbe({ override, minimumRows }: { readonly override?: number; readonly minimumRows?: number }) {
  return <Text>{useListHeight(override, 100, minimumRows)}</Text>;
}

test("list height keeps the default minimum, allows a lower picker minimum, and preserves overrides", () => {
  const view = render(<ListHeightProbe />);
  assert.equal(view.lastFrame(), "3");
  view.rerender(<ListHeightProbe minimumRows={1} />);
  assert.equal(view.lastFrame(), "1");
  view.rerender(<ListHeightProbe override={5} minimumRows={1} />);
  assert.equal(view.lastFrame(), "5");
  view.rerender(<ListHeightProbe override={0} minimumRows={3} />);
  assert.equal(view.lastFrame(), "1");
  view.unmount();
});

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

const CONFIRM: PreviewChrome = { title: "Confirmation", action: "Confirm", consequence: "Confirm? y/n" };

test("preview confirmation follows the rendered physical rows at the viewport end", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `row ${index}`);
  const middle = previewViewport(lines, 6, 15, 80, CONFIRM);
  const footerText = (viewport: typeof middle) => viewport.footer.map(spans => spans.map(({ text }) => text).join(""));
  assert.deepEqual(middle.rows, ["row 4", "row 5", "row 6", "row 7", "row 8"]);
  assert.deepEqual(middle.sourceLines, [4, 5, 6, 7, 8]);
  assert.deepEqual(middle.sourceOffsets, [0, 0, 0, 0, 0]);
  assert.deepEqual([middle.start, middle.end, middle.total, middle.cursor, middle.height, middle.reachedEnd], [4, 9, 10, 6, 5, false]);
  assert.deepEqual(footerText(middle), [
    "read ██████████░░ 90% · Review 7 of 10 · 5–9 of 10 · arrows/Pg page",
    "[y] Confirm  [n] cancel",
  ]);
  const final = previewViewport(lines, 9, 15, 80, CONFIRM);
  assert.deepEqual(final.rows, ["row 5", "row 6", "row 7", "row 8", "row 9"]);
  assert.equal(final.reachedEnd, true);
  assert.deepEqual(footerText(final), [
    "read ✓ · Review 10 of 10 · 6–10 of 10 · Confirm? y/n",
    "[y] Confirm  [n] cancel",
  ]);
  assert.equal(final.height, middle.height, "reading to the end never changes the footer height");
});

test("preview viewport wraps complete long terms and responds to the latest terminal dimensions", () => {
  const line = `Working directory: ${"/resolved/full/path/".repeat(8)}`;
  const wide = previewViewport([line], 0, 24, 80, CONFIRM);
  const narrow = previewViewport([line], 0, 17, 40, CONFIRM);
  assert.equal(wide.total, 3);
  assert.equal(narrow.total, 6);
  const firstPage = previewViewport([line], 0, 17, 40, CONFIRM);
  const lastPage = previewViewport([line], 5, 17, 40, CONFIRM);
  const visibleRows = new Map<number, string>();
  for (const page of [firstPage, lastPage]) page.rows.forEach((row, index) => visibleRows.set(page.start + index, row));
  assert.equal([...visibleRows.entries()].sort(([left], [right]) => left - right).map(([, row]) => row).join(""), line);
  assert.equal(lastPage.reachedEnd, true);
  assert.equal(previewViewport(["界".repeat(19)], 0, 17, 40, CONFIRM).total, 2);
  assert.ok(lastPage.height < wide.height);
});

test("preview viewport offsets preserve grapheme text through CJK, combining marks and emoji wraps", () => {
  const line = `Source git:界e\u0301👩‍💻-${"repeat/".repeat(20)}`;
  const first = previewViewport([line], 0, 17, 40, CONFIRM);
  const continuation = previewViewport([line], first.total - 1, 17, 40, CONFIRM);
  const rows = new Map<number, string>();
  for (const page of [first, continuation]) {
    page.rows.forEach((row, index) => {
      const offset = page.sourceOffsets[index]!;
      assert.equal(line.slice(offset, offset + row.length), row);
      rows.set(offset, row);
    });
  }
  assert.equal([...rows.entries()].sort(([left], [right]) => left - right).map(([, row]) => row).join(""), line);
  assert.ok(continuation.sourceOffsets[0]! > 0);
});

test("preview chrome wraps long approval names into the shared viewport geometry", () => {
  const name = `approved-${"long-recipe-name-".repeat(4)}`;
  const chrome: PreviewChrome = {
    title: "Recipe approval · does not install",
    action: `Approve ${name}`,
    consequence: `Approve ${name}? y/n · recipe approval does not install the App.`,
  };
  const lines = Array.from({ length: 20 }, (_, index) => `danger term ${index}`);
  const wide = previewViewport(lines, 19, 24, 80, chrome);
  const narrow = previewViewport(lines, 19, 17, 40, chrome);
  assert.equal(wide.height, 11);
  assert.equal(narrow.height, 1);
  // 40x17: header 6 rows, gap 1, borders 2, title 2 and the preview row leave 5 footer rows; the rest is cut.
  const narrowFooter = narrow.footer.map(spans => spans.map(({ text }) => text).join(""));
  assert.equal(narrowFooter.length, 5);
  assert.ok(narrowFooter.every(row => row.length <= 32), narrowFooter.join("\n"));
  assert.match(narrowFooter[0]!, /^read ✓ · Review 20 of 20/);
  assert.equal(narrowFooter[3]!.at(-1), "…", narrowFooter.join("\n"));
  assert.match(narrowFooter[4]!, /^\[y\] Approve approved-long-recip.*…$/u);
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
