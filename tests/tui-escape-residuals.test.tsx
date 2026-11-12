import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";
import stringWidth from "string-width";

import { NameField } from "../src/tui/profile-view.js";
import { escapeControlText, previewViewport } from "../src/tui/preview-window.js";
import { clipText, wrapText } from "../src/tui/text-wrap.js";

// What a user typing `\x1b` is shown: the backslash doubled, so it cannot pass for a real ESC (`\x1b`).
const TYPED = "\\\\x1b";

test("wrapping never splits a doubled backslash from the escape text it protects", () => {
  for (const width of [2, 3, 4, 5, 6]) {
    const rows = wrapText(`ab${TYPED}`, width);
    assert.equal(rows.join(""), `ab${TYPED}`);
    // A row ending in one backslash of the pair would start the next with one that reads as an escape.
    for (const row of rows) assert.ok(!/(?<!\\)(?:\\\\)*\\$/u.test(row), `${JSON.stringify(rows)} at ${width}`);
  }
});

test("clipping never leaves half of a doubled backslash before the ellipsis", () => {
  assert.equal(clipText(`ab${TYPED}`, 4), "ab…");
  assert.equal(clipText("plain text", 6), "plain…");
});

test("a name cut from the left keeps a typed escape doubled or drops it whole", () => {
  const view = render(<NameField label="Name: " value={`${"a".repeat(30)}\\x1b`} rows={1} width={11} tail />);
  const frame = view.lastFrame() ?? "";
  view.unmount();
  assert.ok(!/(?<!\\)\\x1b/u.test(frame), frame);
});

/** A row may not end in an odd backslash run, nor start with an odd one before `x1b`: the whole typed run is even. */
function assertParityKept(rows: readonly string[], label: string): void {
  for (const row of rows) {
    assert.ok(!/(?<!\\)(?:\\\\)*\\$/u.test(row), `${label}: ${JSON.stringify(row)} ends in an odd run`);
    const leading = /^(\\*)x1b/u.exec(row)?.[1];
    assert.ok(leading === undefined || leading.length % 2 === 0, `${label}: ${JSON.stringify(row)} starts with an odd run`);
  }
}

test("a long run of typed backslashes before an escape wraps within the width and keeps its parity", () => {
  const width = 10;
  const typed = "\\".repeat(40) + "x1b";
  const rows = wrapText(escapeControlText(typed), width);
  for (const row of rows) assert.ok(stringWidth(row) <= width, `${stringWidth(row)} columns: ${JSON.stringify(row)}`);
  assertParityKept(rows, "wrapText");
  const viewport = previewViewport([typed], 0, 40, width + 8, { title: "t" });
  for (const row of viewport.rows) assert.ok(stringWidth(row) <= width, `${stringWidth(row)} columns: ${JSON.stringify(row)}`);
  assertParityKept(viewport.rows, "previewViewport");
});

test("an escape that is wider than the width still wraps within it", () => {
  const rows = wrapText(escapeControlText("\\u{10ffff}\u202e"), 6);
  for (const row of rows) assert.ok(stringWidth(row) <= 6, JSON.stringify(rows));
});

test("ordinary backslash text, such as a path or a code point, wraps as before", () => {
  assert.deepEqual(wrapText("C:\\tools\\x64\\bin", 5), ["C:\\to", "ols\\x", "64\\bi", "n"]);
  assert.deepEqual(wrapText("a\\u{1F600}b", 4), ["a\\u{", "1F60", "0}b"]);
});
