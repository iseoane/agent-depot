import assert from "node:assert/strict";
import { test } from "node:test";

import type { Key } from "ink";

import type { ProjectHost } from "../src/project-manifest.js";

import { answerYesNo, hostChecklistKey, moveCursor, toggleChoice } from "../src/tui/mode-keys.js";

const plain = {} as Key;
const pressed = (name: keyof Key): Key => ({ [name]: true }) as unknown as Key;
const choices: readonly ProjectHost[] = ["pi", "claude", "codex"];

test("moveCursor moves with arrows and j/k and stays within the list", () => {
  assert.equal(moveCursor(0, 3, "j", plain), 1);
  assert.equal(moveCursor(2, 3, "", pressed("downArrow")), 2);
  assert.equal(moveCursor(1, 3, "k", plain), 0);
  assert.equal(moveCursor(0, 3, "", pressed("upArrow")), 0);
  assert.equal(moveCursor(1, 3, "x", plain), undefined);
});

test("toggleChoice flips one choice and keeps the order of the choices", () => {
  assert.deepEqual(toggleChoice(["a", "b", "c"], ["c"], "a"), ["a", "c"]);
  assert.deepEqual(toggleChoice(["a", "b", "c"], ["a", "c"], "c"), ["a"]);
});

test("hostChecklistKey cancels, moves, toggles by space or digit and submits only a selection", () => {
  const state = { cursor: 1, selected: [] as readonly ProjectHost[] };
  assert.deepEqual(hostChecklistKey(state, choices, "", pressed("escape")), { kind: "cancel" });
  assert.deepEqual(hostChecklistKey(state, choices, "j", plain), { kind: "update", state: { cursor: 2, selected: [] } });
  assert.deepEqual(hostChecklistKey(state, choices, " ", plain), { kind: "update", state: { cursor: 1, selected: [choices[1]] } });
  assert.deepEqual(hostChecklistKey(state, choices, "3", plain), { kind: "update", state: { cursor: 1, selected: [choices[2]] } });
  assert.deepEqual(hostChecklistKey(state, choices, "9", plain), { kind: "ignore" });
  assert.deepEqual(hostChecklistKey(state, choices, "\r", pressed("return")), { kind: "empty" });
  assert.deepEqual(
    hostChecklistKey({ cursor: 0, selected: [choices[0]!] }, choices, "\r", pressed("return")),
    { kind: "submit", selected: [choices[0]] },
  );
});

test("answerYesNo confirms on y, declines on n or Esc and ignores other keys", () => {
  const calls: string[] = [];
  const run = (input: string, key: Key) => answerYesNo(input, key, () => calls.push("yes"), () => calls.push("no"));
  run("y", plain);
  run("n", plain);
  run("", pressed("escape"));
  run("x", plain);
  assert.deepEqual(calls, ["yes", "no", "no"]);
});
