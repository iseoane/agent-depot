import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { NameField } from "../src/tui/profile-view.js";
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
