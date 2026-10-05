import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import type { UserGlobalSkillInstallation } from "../src/source-state.js";
import type { GitSource } from "../src/git-source.js";
import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const external: GitSource = {
  id: "git:1234567890abcdef12345678",
  kind: "git",
  url: "https://github.com/example/skills.git",
};
const added: GitSource = { id: "git:aaaaaaaaaaaaaaaaaaaaaaaa", kind: "git", url: "https://github.com/example/new.git" };

const DOWN = "\u001B[B";
const ESC = "\u001B";

interface Harness {
  readonly operations: SourceOperations;
  readonly calls: string[];
  sources: Source[];
}

function harness(overrides: Partial<SourceOperations> = {}, withRemoval = true): Harness {
  const state: Harness = { calls: [], sources: [BUILT_IN_SOURCE, external], operations: undefined as never };
  const operations: SourceOperations = {
    async addGitSource(url) {
      state.calls.push(`add ${url}`);
      state.sources = [...state.sources, added];
      return added;
    },
    async listSources() {
      return state.sources;
    },
    async refreshSource(id) {
      state.calls.push(`refresh ${id}`);
      return external;
    },
    async selectSources() {
      return [];
    },
    ...(withRemoval
      ? {
          async listUserGlobalInstallations() {
            return [] as readonly UserGlobalSkillInstallation[];
          },
          async removeGitSource(id: string) {
            state.calls.push(`remove ${id}`);
            state.sources = state.sources.filter((source) => source.id !== id);
          },
        }
      : {}),
    ...overrides,
  };
  return Object.assign(state, { operations });
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function open(h: Harness) {
  const view = render(<SourcesView operations={h.operations} />);
  await waitForFrame(view.lastFrame, /builtin:agent-depot/);
  return view;
}

/** Waits until the highlighted row (the one prefixed with "> ") matches. */
const highlights = (lastFrame: () => string | undefined, id: RegExp) =>
  waitForFrame(lastFrame, (frame) => id.test(frame.split("\n").find((line) => line.startsWith("> ")) ?? ""));

test("n opens an input, Enter adds the Git Source, reloads the list and reports success", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("n1");
  await waitForFrame(lastFrame, /URL:/);
  stdin.write(added.url);
  await waitForFrame(lastFrame, /example\/new\.git/);
  stdin.write("\r");
  const frame = await waitForFrame(lastFrame, /Added Git Source: git:aaaa/);
  assert.deepEqual(h.calls, [`add ${added.url}`]);
  await waitForFrame(lastFrame, /git:aaaaaaaaaaaaaaaaaaaaaaaa\s+skills/);
  assert.match(frame, /Added Git Source: git:aaaa/);
  unmount();
});

test("pasting text that starts like an escape remnant keeps it in the URL input", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("n1");
  await waitForFrame(lastFrame, /URL:/);
  stdin.write("Ok");
  await waitForFrame(lastFrame, /URL: Ok/);
  unmount();
});

test("Esc cancels the add input without calling operations; backspace edits", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("n1");
  await waitForFrame(lastFrame, /URL:/);
  stdin.write("abc");
  stdin.write("\u007F");
  await waitForFrame(lastFrame, /URL: ab(?!c)/);
  stdin.write(ESC);
  await waitForFrame(lastFrame, (frame) => !/URL:/.test(frame));
  assert.deepEqual(h.calls, []);
  unmount();
});

test("add errors are shown and keep the list", async () => {
  const h = harness({ async addGitSource() { throw new Error("clone failed"); } });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("n1");
  await waitForFrame(lastFrame, /URL:/);
  stdin.write("x");
  stdin.write("\r");
  const frame = await waitForFrame(lastFrame, /Error: clone failed/);
  assert.match(frame, /git:1234/);
  unmount();
});

test("r previews, y confirms and refreshes the highlighted source", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("r");
  await waitForFrame(lastFrame, /refresh Git Source git:1234567890abcdef12345678 from https:\/\/github\.com\/example\/skills\.git/);
  assert.deepEqual(h.calls, []);
  stdin.write("y");
  await waitForFrame(lastFrame, /Refreshed Git Source: git:1234/);
  assert.deepEqual(h.calls, ["refresh git:1234567890abcdef12345678"]);
  unmount();
});

test("n and Esc cancel a refresh confirmation", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  for (const cancel of ["n", ESC]) {
    stdin.write("r");
    await waitForFrame(lastFrame, /\[y\/n\]/);
    stdin.write(cancel);
    await waitForFrame(lastFrame, (frame) => !/\[y\/n\]/.test(frame));
  }
  assert.deepEqual(h.calls, []);
  unmount();
});

test("r and d act on the first Git source, never on the fixed built-in row", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  await highlights(lastFrame, /git:1234/);
  stdin.write("d");
  const frame = await waitForFrame(lastFrame, /remove Git Source git:1234567890abcdef12345678/);
  assert.doesNotMatch(frame, /cannot be (refreshed|removed)/i);
  assert.deepEqual(h.calls, []);
  unmount();
});

test("d previews, y removes the source and reloads the list", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("d");
  await waitForFrame(lastFrame, /remove Git Source git:1234567890abcdef12345678 from https:\/\/github\.com\/example\/skills\.git/);
  stdin.write("y");
  const frame = await waitForFrame(lastFrame, /Removed Git Source: git:1234/);
  assert.deepEqual(h.calls, ["remove git:1234567890abcdef12345678"]);
  assert.doesNotMatch(frame, /git:1234567890abcdef12345678\s+skills/);
  unmount();
});

test("d is blocked when user-global installations depend on the source", async () => {
  const dependent = { source: { kind: "external", url: external.url }, path: "skills/a" } as unknown as UserGlobalSkillInstallation;
  const h = harness({ async listUserGlobalInstallations() { return [dependent]; } });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("d");
  const frame = await waitForFrame(lastFrame, /agent-depot source remove git:1234567890abcdef12345678/);
  assert.doesNotMatch(frame, /\[y\/n\]/);
  assert.deepEqual(h.calls, []);
  unmount();
});

test("d says not supported when removal is unavailable", async () => {
  const h = harness({}, false);
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("d");
  await waitForFrame(lastFrame, /not supported/i);
  unmount();
});

test("a busy action ignores other keys", async () => {
  let release: (() => void) | undefined;
  const h = harness({
    refreshSource: () => new Promise<GitSource>((resolve) => { release = () => resolve(external); }),
  });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("r");
  await waitForFrame(lastFrame, /\[y\/n\]/);
  stdin.write("y");
  await waitForFrame(lastFrame, /Working/);
  // Keys are handled in order: once "j" (a no-op while busy) had its turn, "a" would already have opened the input.
  stdin.write("n");
  stdin.write("j");
  release?.();
  const frame = await waitForFrame(lastFrame, /Refreshed Git Source/);
  assert.doesNotMatch(frame, /URL:/);
  unmount();
});

test("App shows key hints and q does not quit while typing or confirming", async () => {
  const h = harness();
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={h.operations} onExit={() => { exits += 1; }} />);
  await waitForFrame(lastFrame, /n add/);
  stdin.write("n1");
  await waitForFrame(lastFrame, /URL:/);
  stdin.write("q");
  await waitForFrame(lastFrame, /URL: q/);
  assert.equal(exits, 0);
  stdin.write(ESC);
  await waitForFrame(lastFrame, (frame) => !/URL:/.test(frame));
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("r");
  await waitForFrame(lastFrame, /\[y\/n\]/);
  stdin.write("q");
  stdin.write("n");
  await waitForFrame(lastFrame, (frame) => !/\[y\/n\]/.test(frame));
  assert.equal(exits, 0);
  stdin.write("q");
  await waitFor(() => exits === 1);
  unmount();
});

test("App ignores q and view keys sent in the same burst as a capturing key", async () => {
  const h = harness();
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={h.operations} onExit={() => { exits += 1; }} />);
  await waitForFrame(lastFrame, /n add/);
  stdin.write("n1");
  stdin.write("q");
  stdin.write("2");
  const frame = await waitForFrame(lastFrame, /URL: q2/);
  assert.equal(exits, 0);
  assert.match(frame, /\[1 Sources\]/);
  unmount();
});

test("App does not quit or switch views while an action is busy", async () => {
  let release: (() => void) | undefined;
  const h = harness({
    refreshSource: () => new Promise<GitSource>((resolve) => { release = () => resolve(external); }),
  });
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={h.operations} onExit={() => { exits += 1; }} />);
  await waitForFrame(lastFrame, /builtin:agent-depot/);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("r");
  await waitForFrame(lastFrame, /\[y\/n\]/);
  stdin.write("y");
  stdin.write("q");
  stdin.write("2");
  await waitForFrame(lastFrame, /Working/);
  release?.();
  const frame = await waitForFrame(lastFrame, /Refreshed Git Source/);
  assert.equal(exits, 0);
  assert.match(frame, /\[1 Sources\]/);
  unmount();
});

test("the highlight stays on the same source when a new source sorts before it", async () => {
  const h = harness({
    async addGitSource(url) {
      h.calls.push(`add ${url}`);
      h.sources = [BUILT_IN_SOURCE, added, external];
      return added;
    },
  });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("n1");
  await waitForFrame(lastFrame, /URL:/);
  stdin.write(added.url);
  await waitForFrame(lastFrame, /example\/new\.git/);
  stdin.write("\r");
  await waitForFrame(lastFrame, /Added Git Source/);
  await waitForFrame(lastFrame, (frame) => new RegExp(`> (\\[.\\] )?${external.id}`).test(frame) && frame.includes(added.id));
  unmount();
});

test("no reload is issued after the view unmounts mid-action", async () => {
  let release: (() => void) | undefined;
  let lists = 0;
  const h = harness({
    async listSources() {
      lists += 1;
      return h.sources;
    },
    refreshSource: () => new Promise<GitSource>((resolve) => { release = () => resolve(external); }),
  });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await highlights(lastFrame, /git:1234/);
  stdin.write("r");
  await waitForFrame(lastFrame, /\[y\/n\]/);
  stdin.write("y");
  await waitForFrame(lastFrame, /Working/);
  unmount();
  const before = lists;
  release?.();
  // The refresh promise resolves on the microtask queue; a macrotask turn lets any (wrong) reload run before we look.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lists, before);
});
