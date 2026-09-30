import assert from "node:assert/strict";
import { test } from "node:test";

import { runBatch } from "../src/tui/batch.js";

test("runBatch applies items in order and reports each outcome", async () => {
  const seen: number[] = [];
  const outcomes = await runBatch([1, 2, 3], async (item) => {
    seen.push(item);
    return `did ${item}`;
  }, (item, error) => `Failed ${item}: ${String(error)}`);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(outcomes.map((outcome) => [outcome.item, outcome.ok, outcome.line]), [
    [1, true, "did 1"],
    [2, true, "did 2"],
    [3, true, "did 3"],
  ]);
});

test("runBatch keeps going after a failure and describes it with the failure formatter", async () => {
  const outcomes = await runBatch(["a", "b", "c"], async (item) => {
    if (item === "b") throw new Error("boom");
    return `did ${item}`;
  }, (item, error) => `Failed ${item}: ${(error as Error).message}`);
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, false, true]);
  assert.equal(outcomes[1]!.line, "Failed b: boom");
  assert.equal(outcomes[2]!.line, "did c");
});
