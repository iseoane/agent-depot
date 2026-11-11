import assert from "node:assert/strict";
import { test } from "node:test";

import { formatProgressLabel } from "../src/flow-progress.js";
import { isWorkingFrame } from "../src/tui/working-model.js";

test("names the kind, the item and its position in the batch", () => {
  assert.equal(formatProgressLabel({ kind: "skill", name: "portable/tdd", position: 2, total: 5, verb: "Updating" }), "Updating Skill portable/tdd (2/5)…");
  assert.equal(formatProgressLabel({ kind: "app", name: "demo", position: 1, total: 3, verb: "Updating" }), "Updating App demo (1/3)…");
  assert.equal(formatProgressLabel({ kind: "package", name: "pkg", position: 3, total: 3, verb: "Installing" }), "Installing Package pkg (3/3)…");
});

test("a batch of one omits the position", () => {
  assert.equal(formatProgressLabel({ kind: "skill", name: "tdd", position: 1, total: 1, verb: "Installing" }), "Installing Skill tdd…");
});

test("every label is a Working line", () => {
  const label = formatProgressLabel({ kind: "app", name: "demo", position: 1, total: 2, verb: "Updating" });
  assert.equal(isWorkingFrame(`· ${label}`), true);
});
