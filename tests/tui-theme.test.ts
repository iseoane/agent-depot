import assert from "node:assert/strict";
import { test } from "node:test";

import { separatorLine, theme } from "../src/tui/theme.js";

test("theme carries the xeo palette", () => {
  assert.equal(theme.accent, "#ff2e9a");
  assert.equal(theme.group, "#7aa2f7");
  assert.equal(theme.marker, "#449dab");
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
