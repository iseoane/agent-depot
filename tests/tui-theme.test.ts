import assert from "node:assert/strict";
import { test } from "node:test";

import { separatorLine, theme } from "../src/tui/theme.js";

test("theme carries Xeo colors through explicit semantic roles", () => {
  assert.equal(theme.title, "#ad8ee6");
  assert.equal(theme.accent, "#ff2e9a");
  assert.equal(theme.border, "#7aa2f7");
  assert.equal(theme.group, "#7aa2f7");
  assert.equal(theme.field, "#449dab");
  assert.equal(theme.marker, "#449dab");
  assert.equal(theme.text, "#a9b1d6");
  assert.equal(theme.value, "#c0caf5");
  assert.equal(theme.legend, "#565f89");
  assert.equal(theme.success, "#9ece6a");
  assert.equal(theme.warning, "#e0af68");
  assert.equal(theme.error, "#f7768e");
  assert.equal(theme.muted, "#414868");
  assert.equal(theme.inactive, "#565f89");
  assert.equal(theme.selection, "#292e42");
});

test("separatorLine fills the terminal width with a fallback", () => {
  assert.equal(separatorLine(12), "═".repeat(12));
  assert.equal(separatorLine(undefined), "═".repeat(80));
  assert.equal(separatorLine(0), "═".repeat(80));
});
