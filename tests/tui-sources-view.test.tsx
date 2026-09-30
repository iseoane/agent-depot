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
  assert.match(frame, /builtin:agent-depot\s+builtin/);
  assert.match(frame, /git:1234567890abcdef12345678\s+git\s+https:\/\/github\.com\/example\/skills\.git/);
  unmount();
});

test("SourcesView shows an empty state", async () => {
  const { lastFrame, unmount } = render(<SourcesView operations={operationsFor(async () => [])} />);
  await waitForFrame(lastFrame, /No sources/);
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
  const { lastFrame, stdin, unmount } = render(
    <SourcesView operations={operationsFor(async () => [BUILT_IN_SOURCE, external])} />,
  );
  const selects = (name: RegExp) => waitForFrame(lastFrame, (frame) => name.test(selectedLine(frame) ?? ""));
  await selects(/builtin:agent-depot/);

  stdin.write(DOWN);
  await selects(/git:1234/);

  // j at the bottom is clamped: if it moved past the end, one Up would not return to the first source.
  stdin.write("j");
  stdin.write(UP);
  await selects(/builtin:agent-depot/);

  // k at the top is clamped: if it moved above the start, j would not land on the second source.
  stdin.write("k");
  stdin.write("j");
  await selects(/git:1234/);
  unmount();
});
