import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const external = {
  id: "git:1234567890abcdef12345678",
  kind: "git" as const,
  url: "https://github.com/example/skills.git",
};

const DOWN = "\u001B[B";
const UP = "\u001B[A";

function operationsFor(listSources: SourceOperations["listSources"]): SourceOperations {
  return {
    async addGitSource() {
      return external;
    },
    listSources,
    async refreshSource() {
      return external;
    },
    async selectSources() {
      return [];
    },
  };
}

function selectedLine(frame: string | undefined): string | undefined {
  return frame?.split("\n").find((line) => line.startsWith("> "));
}

test("SourcesView shows a loading state before sources resolve", () => {
  const { lastFrame, unmount } = render(
    <SourcesView operations={operationsFor(() => new Promise(() => undefined))} />,
  );
  assert.match(lastFrame() ?? "", /Loading sources/);
  unmount();
});

test("SourcesView lists id, kind and url of each source", async () => {
  const sources: readonly Source[] = [BUILT_IN_SOURCE, external];
  const { lastFrame, unmount } = render(<SourcesView operations={operationsFor(async () => sources)} />);
  const frame = await waitForFrame(lastFrame, /git:1234567890abcdef12345678/);
  assert.match(frame, /builtin:agent-depot\s+skills\s+included/);
  assert.match(frame, /git:1234567890abcdef12345678\s+skills\s+https:\/\/github\.com\/example\/skills\.git/);
  unmount();
});

test("SourcesView shows an empty Git state, with or without the built-in source", async () => {
  for (const sources of [[], [BUILT_IN_SOURCE]] as const) {
    const { lastFrame, unmount } = render(<SourcesView operations={operationsFor(async () => sources)} />);
    const frame = await waitForFrame(lastFrame, /No sources or App recipes · n to add/);
    assert.doesNotMatch(selectedLine(frame) ?? "", /./);
    unmount();
  }
});

test("SourcesView shows the built-in source as a fixed row above the list that is never highlighted", async () => {
  const other = { ...external, id: "git:abcdef1234567890abcdef12", url: "https://github.com/example/other.git" };
  const { lastFrame, stdin, unmount } = render(
    <SourcesView operations={operationsFor(async () => [BUILT_IN_SOURCE, external, other])} />,
  );
  let frame = await waitForFrame(lastFrame, /git:1234567890abcdef12345678/);
  const lines = frame.split("\n");
  const builtin = lines.findIndex((line) => line.includes("builtin:agent-depot  skills  included"));
  assert.ok(builtin >= 0 && builtin < lines.findIndex((line) => line.includes(external.id)), frame);
  assert.doesNotMatch(lines[builtin] ?? "", /^>|\[.\]/);
  // The cursor starts on the first Git source and cannot move up onto the built-in row.
  assert.match(selectedLine(frame) ?? "", /git:1234/);
  stdin.write(UP);
  stdin.write(UP);
  stdin.write("j");
  frame = await waitForFrame(lastFrame, (candidate) => /abcdef1234567890/.test(selectedLine(candidate) ?? ""));
  assert.equal(frame.split("\n").filter((line) => line.startsWith("> ")).length, 1);
  unmount();
});

test("SourcesView shows the error message when loading fails", async () => {
  const { lastFrame, unmount } = render(
    <SourcesView operations={operationsFor(async () => { throw new Error("registry unreadable"); })} />,
  );
  await waitForFrame(lastFrame, /registry unreadable/);
  unmount();
});

test("SourcesView moves the selection with arrows and j/k, clamped to the list", async () => {
  const other = { ...external, id: "git:abcdef1234567890abcdef12", url: "https://github.com/example/other.git" };
  const { lastFrame, stdin, unmount } = render(
    <SourcesView operations={operationsFor(async () => [BUILT_IN_SOURCE, external, other])} />,
  );
  const selects = (name: RegExp) => waitForFrame(lastFrame, (frame) => name.test(selectedLine(frame) ?? ""));
  await selects(/git:1234/);

  stdin.write(DOWN);
  await selects(/git:abcdef/);

  // j at the bottom is clamped: if it moved past the end, one Up would not return to the first source.
  stdin.write("j");
  stdin.write(UP);
  await selects(/git:1234/);

  // k at the top is clamped: if it moved above the start, j would not land on the second source.
  stdin.write("k");
  stdin.write("j");
  await selects(/git:abcdef/);
  unmount();
});
