import assert from "node:assert/strict";
import { test } from "node:test";

import { Text } from "ink";
import { render } from "ink-testing-library";

import { useKeys } from "../src/tui/keys.js";
import { waitForFrame } from "./wait-for-frame.js";

/** Records every input the handler receives, joined by `|`. */
function Probe({ seen }: { readonly seen: string[] }) {
  useKeys((input) => {
    seen.push(input);
  });
  return <Text>probe</Text>;
}

async function received(chunks: readonly string[]): Promise<string[]> {
  const seen: string[] = [];
  const view = render(<Probe seen={seen} />);
  await waitForFrame(view.lastFrame, /probe/);
  for (const chunk of chunks) {
    view.stdin.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  view.unmount();
  return seen;
}

test("a burst of plain characters is delivered one key at a time, in order", async () => {
  assert.deepEqual(await received(["jj "]), ["j", "j", " "]);
});

test("a pasted URL is delivered character by character", async () => {
  const url = "https://example.com/a?b=1";
  assert.deepEqual(await received([url]), [...url]);
});

test("escape sequences that reach the handler without their ESC are never split", async () => {
  for (const sequence of ["[200~", "[201~", "[I", "[O", "[<0;10;5M", "[<0;10;5m", "OA"]) {
    const seen = await received([sequence]);
    assert.ok(seen.every((input) => input.length !== 1 || input === "A"), `${sequence} was split into ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((input) => ["1", "2", "3", "j", "k", " ", "I", "O", "M", "m", "~"].includes(input)), `${sequence} leaked keys ${JSON.stringify(seen)}`);
  }
});

test("escape sequences with their ESC do not leak single keys either", async () => {
  for (const sequence of ["\u001B[200~", "\u001B[I", "\u001B[<0;10;5M"]) {
    const seen = await received([sequence]);
    assert.ok(!seen.some((input) => input.length === 1 && input !== ""), `${JSON.stringify(sequence)} leaked ${JSON.stringify(seen)}`);
  }
});

test("text inside a bracketed paste is still delivered as keys", async () => {
  assert.deepEqual(await received(["[200~", "ab", "[201~"]).then((seen) => seen.filter((input) => input.length === 1)), ["a", "b"]);
});
