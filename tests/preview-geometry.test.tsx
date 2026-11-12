import assert from "node:assert/strict";
import { test } from "node:test";
import { Box } from "ink";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { PagedPreview } from "../src/tui/panel-parts.js";
import { headerTabRowCount } from "../src/tui/header-layout.js";
import { lineText, stepBlockLines } from "../src/tui/preview-render.js";
import { previewViewport, type PreviewChrome } from "../src/tui/preview-window.js";
import { showsWorkingPanel } from "../src/tui/updates-view.js";
import { panelRows } from "./preview-footer.js";

const WIDTH = 40;
const CONTENT = WIDTH - 8;

test("a step line that wraps keeps the tree gutter and its indent on every continuation row", () => {
  const styled = stepBlockLines([
    { step: "install", argv: ["tool", "--option", "a-very-long-argument-value-that-needs-wrapping", "--another", "value"], executable: "/bin/tool", cwd: "/work" },
    { step: "verify", manual: "read the documentation carefully and then confirm that the setup is complete", cwd: "/work" },
  ]);
  const lines = styled.map(lineText);
  const chrome: PreviewChrome = { title: "Steps" };
  const viewport = previewViewport(lines, 0, 60, WIDTH, chrome);
  const view = render(<PagedPreview lines={lines} styled={styled} viewport={viewport} />);
  const rows = panelRows(view.lastFrame() ?? "");
  view.unmount();
  const continuations = viewport.rows.flatMap((row, position) => viewport.sourceOffsets[position]! > 0 ? [{ row, source: viewport.sourceLines[position]! }] : []);
  assert.ok(continuations.length >= 2, JSON.stringify(viewport.rows));
  for (const { row, source } of continuations) {
    const expected = lines[source]!.startsWith(" │") ? " │ " : "   ";
    assert.ok(row.startsWith(expected) && !row.startsWith(`${expected} `), JSON.stringify(row));
    assert.ok(stringWidth(row) <= CONTENT, JSON.stringify(row));
    assert.ok(rows.map(drawn => drawn.trimEnd()).includes(row.trimEnd()), `${JSON.stringify(row)} is drawn`);
  }
  // Nothing is lost: the joined continuation text reproduces each logical line.
  const rebuilt = lines.map((_, source) => viewport.rows.filter((__, position) => viewport.sourceLines[position] === source)
    .map((row, position) => position === 0 ? row : row.slice(3)).join(""));
  assert.deepEqual(rebuilt, lines);
});

test("a title of over 200 characters leaves a row of content inside 40x17", () => {
  const chrome: PreviewChrome = { title: "T".repeat(220), action: "Apply", consequence: "Apply? y/n" };
  const lines = Array.from({ length: 40 }, (_, position) => `line ${position}`);
  const viewport = previewViewport(lines, 0, 17, WIDTH, chrome);
  assert.ok(viewport.height >= 1 && viewport.rows.length >= 1);
  assert.ok(viewport.titleRows.at(-1)!.endsWith("…"), viewport.titleRows.join("\n"));
  // A terminal wraps the title at the content width: header, gap, borders, title, content and footer rows.
  const titleRows = viewport.titleRows.length;
  const total = headerTabRowCount(CONTENT) + 3 + 1 + 2 + titleRows + viewport.rows.length + viewport.footer.length;
  assert.ok(total <= 17, `${total} rows`);
});

test("the working panel is not shown over a preview", () => {
  assert.equal(showsWorkingPanel({ status: "loading", label: "x", startedAt: 0 }, { kind: "browse" }), true);
  assert.equal(showsWorkingPanel({ status: "loading", label: "x", startedAt: 0 }, { kind: "busy", label: "x", startedAt: 0 }), true);
  for (const kind of ["preview", "manual", "confirm-paths"] as const) {
    assert.equal(showsWorkingPanel({ status: "loading", label: "x", startedAt: 0 }, { kind } as never), false, kind);
  }
});

const WORDS = Array.from({ length: 14 }, (_, position) => `titleword-${String(position).padStart(9, "x")}`).join(" ");

test("a multi-word title is drawn on the rows the layout counted, in a 40-column terminal", () => {
  const chrome: PreviewChrome = { title: WORDS, action: "Apply", consequence: "Apply? y/n" };
  const lines = Array.from({ length: 40 }, (_, position) => `line ${position}`);
  const viewport = previewViewport(lines, 0, 17, WIDTH, chrome);
  const view = render(<Box width={WIDTH}><PagedPreview lines={lines} viewport={viewport} /></Box>);
  const frameRows = (view.lastFrame() ?? "").split("\n").length;
  view.unmount();
  const outside = headerTabRowCount(CONTENT) + 4;
  assert.ok(frameRows + outside <= 17, `${frameRows} rows plus ${outside} outside the panel`);
});

test("a long title leaves the footer its question and its [y] action at 40x17", () => {
  const chrome: PreviewChrome = { title: WORDS, action: "Apply it", consequence: "Apply the batch now? y/n" };
  const lines = Array.from({ length: 40 }, (_, position) => `line ${position}`);
  const viewport = previewViewport(lines, 39, 17, WIDTH, chrome);
  assert.ok(viewport.reachedEnd);
  const view = render(<Box width={WIDTH}><PagedPreview lines={lines} viewport={viewport} /></Box>);
  const frame = (view.lastFrame() ?? "").replace(/[│\s]/gu, "");
  view.unmount();
  assert.ok(frame.includes("Applythebatchnow?y/n"), frame);
  assert.ok(frame.includes("[y]Applyit"), frame);
  assert.ok(viewport.rows.length >= 1);
});
