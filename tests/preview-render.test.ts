import assert from "node:assert/strict";
import { test } from "node:test";

import { lineText, renderPreviewDocument } from "../src/tui/preview-render.js";
import { theme } from "../src/tui/theme.js";

test("the preview document colours titles, origins, versions, commands and warnings", () => {
  const lines = renderPreviewDocument({
    action: "Apply 1 update",
    summary: "1 App",
    context: ["Environment: linux"],
    warnings: [],
    sections: [{ heading: "APPS", items: [{
      title: "ripgrep", detail: "recipes", version: { from: "14.1.0", to: "14.1.1" },
      rows: [{ kind: "command", argv: ["rg", "--update"], cwd: "/home/me" }, { kind: "warning", text: '"rg" not found in PATH' }],
    }] }],
    failures: ["bad: broken"],
  });
  const spanOf = (text: string) => lines.flat().find((span) => span.text.trim() === text.trim());
  assert.deepEqual(spanOf("Apply 1 update"), { text: "Apply 1 update", color: theme.accent, bold: true });
  assert.deepEqual(spanOf("APPS"), { text: "APPS", color: theme.field, bold: true });
  assert.deepEqual(spanOf("ripgrep"), { text: " ripgrep", color: theme.value, bold: true });
  assert.equal(spanOf("  recipes")?.color, theme.legend);
  assert.equal(spanOf("  14.1.0 → 14.1.1")?.color, theme.version);
  assert.equal(spanOf("   $ rg --update")?.color, theme.value);
  assert.equal(spanOf("   in /home/me")?.color, theme.legend);
  assert.equal(spanOf("⚠ ripgrep: \"rg\" not found in PATH")?.color, theme.warning);
  assert.equal(spanOf("⚠ \"rg\" not found in PATH")?.color, theme.warning);
  assert.equal(spanOf("FAILED")?.color, theme.error);
  assert.deepEqual(lines.map(lineText), [
    "Apply 1 update  1 App",
    " Environment: linux",
    ' ⚠ ripgrep: "rg" not found in PATH',
    " ",
    "APPS",
    " ripgrep  recipes  14.1.0 → 14.1.1",
    "   $ rg --update",
    "   in /home/me",
    '   ⚠ "rg" not found in PATH',
    " ",
    "FAILED",
    " bad: broken",
  ]);
});
