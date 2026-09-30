import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";

const external = {
  id: "git:1234567890abcdef12345678",
  kind: "git" as const,
  url: "https://github.com/example/skills.git",
};

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  await tick();
  const frame = lastFrame() ?? "";
  assert.match(frame, /builtin:agent-depot\s+builtin/);
  assert.match(frame, /git:1234567890abcdef12345678\s+git\s+https:\/\/github\.com\/example\/skills\.git/);
  unmount();
});

test("SourcesView shows an empty state", async () => {
  const { lastFrame, unmount } = render(<SourcesView operations={operationsFor(async () => [])} />);
  await tick();
  assert.match(lastFrame() ?? "", /No sources/);
  unmount();
});

test("SourcesView shows the error message when loading fails", async () => {
  const { lastFrame, unmount } = render(
    <SourcesView operations={operationsFor(async () => { throw new Error("registry unreadable"); })} />,
  );
  await tick();
  assert.match(lastFrame() ?? "", /registry unreadable/);
  unmount();
});

test("SourcesView moves the selection with arrows and j/k, clamped to the list", async () => {
  const { lastFrame, stdin, unmount } = render(
    <SourcesView operations={operationsFor(async () => [BUILT_IN_SOURCE, external])} />,
  );
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /builtin:agent-depot/);

  stdin.write(DOWN);
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /git:1234/);

  stdin.write("j");
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /git:1234/);

  stdin.write(UP);
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /builtin:agent-depot/);

  stdin.write("k");
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /builtin:agent-depot/);

  stdin.write("j");
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /git:1234/);
  unmount();
});
