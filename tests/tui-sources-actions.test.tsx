import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import type { UserGlobalSkillInstallation } from "../src/source-state.js";
import type { GitSource } from "../src/git-source.js";
import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { SourcesView } from "../src/tui/sources-view.js";

const external: GitSource = {
  id: "git:1234567890abcdef12345678",
  kind: "git",
  url: "https://github.com/example/skills.git",
};
const added: GitSource = { id: "git:aaaaaaaaaaaaaaaaaaaaaaaa", kind: "git", url: "https://github.com/example/new.git" };

const DOWN = "\u001B[B";
const ESC = "\u001B";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

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

async function open(h: Harness) {
  const view = render(<SourcesView operations={h.operations} />);
  await tick();
  return view;
}

test("a opens an input, Enter adds the Git Source, reloads the list and reports success", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("a");
  await tick();
  assert.match(lastFrame() ?? "", /URL:/);
  stdin.write(added.url);
  await tick();
  assert.match(lastFrame() ?? "", /example\/new\.git/);
  stdin.write("\r");
  await tick();
  assert.deepEqual(h.calls, [`add ${added.url}`]);
  assert.match(lastFrame() ?? "", /Added Git Source: git:aaaa/);
  assert.match(lastFrame() ?? "", /git:aaaaaaaaaaaaaaaaaaaaaaaa\s+git/);
  unmount();
});

test("Esc cancels the add input without calling operations; backspace edits", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("a");
  await tick();
  stdin.write("abc");
  stdin.write("\u007F");
  await tick();
  assert.match(lastFrame() ?? "", /URL: ab(?!c)/);
  stdin.write(ESC);
  await tick();
  assert.doesNotMatch(lastFrame() ?? "", /URL:/);
  assert.deepEqual(h.calls, []);
  unmount();
});

test("add errors are shown and keep the list", async () => {
  const h = harness({ async addGitSource() { throw new Error("clone failed"); } });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("a");
  await tick();
  stdin.write("x");
  stdin.write("\r");
  await tick();
  assert.match(lastFrame() ?? "", /Error: clone failed/);
  assert.match(lastFrame() ?? "", /git:1234/);
  unmount();
});

test("r previews, y confirms and refreshes the highlighted source", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await tick();
  stdin.write("r");
  await tick();
  assert.match(lastFrame() ?? "", /refresh Git Source git:1234567890abcdef12345678 from https:\/\/github\.com\/example\/skills\.git/);
  assert.deepEqual(h.calls, []);
  stdin.write("y");
  await tick();
  assert.deepEqual(h.calls, ["refresh git:1234567890abcdef12345678"]);
  assert.match(lastFrame() ?? "", /Refreshed Git Source: git:1234/);
  unmount();
});

test("n and Esc cancel a refresh confirmation", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  for (const cancel of ["n", ESC]) {
    await tick();
    stdin.write("r");
    await tick();
    stdin.write(cancel);
    await tick();
    assert.doesNotMatch(lastFrame() ?? "", /\[y\/n\]/);
  }
  assert.deepEqual(h.calls, []);
  unmount();
});

test("built-in source cannot be refreshed or removed", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write("r");
  await tick();
  assert.match(lastFrame() ?? "", /built-in source cannot be refreshed/i);
  stdin.write("d");
  await tick();
  assert.match(lastFrame() ?? "", /built-in source cannot be removed/i);
  assert.deepEqual(h.calls, []);
  unmount();
});

test("d previews, y removes the source and reloads the list", async () => {
  const h = harness();
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await tick();
  stdin.write("d");
  await tick();
  assert.match(lastFrame() ?? "", /remove Git Source git:1234567890abcdef12345678 from https:\/\/github\.com\/example\/skills\.git/);
  stdin.write("y");
  await tick();
  assert.deepEqual(h.calls, ["remove git:1234567890abcdef12345678"]);
  assert.match(lastFrame() ?? "", /Removed Git Source: git:1234/);
  assert.doesNotMatch(lastFrame() ?? "", /git:1234567890abcdef12345678\s+git/);
  unmount();
});

test("d is blocked when user-global installations depend on the source", async () => {
  const dependent = { source: { kind: "external", url: external.url }, path: "skills/a" } as unknown as UserGlobalSkillInstallation;
  const h = harness({ async listUserGlobalInstallations() { return [dependent]; } });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await tick();
  stdin.write("d");
  await tick();
  assert.match(lastFrame() ?? "", /agent-depot source remove git:1234567890abcdef12345678/);
  assert.doesNotMatch(lastFrame() ?? "", /\[y\/n\]/);
  assert.deepEqual(h.calls, []);
  unmount();
});

test("d says not supported when removal is unavailable", async () => {
  const h = harness({}, false);
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await tick();
  stdin.write("d");
  await tick();
  assert.match(lastFrame() ?? "", /not supported/i);
  unmount();
});

test("a busy action ignores other keys", async () => {
  let release: (() => void) | undefined;
  const h = harness({
    refreshSource: () => new Promise<GitSource>((resolve) => { release = () => resolve(external); }),
  });
  const { lastFrame, stdin, unmount } = await open(h);
  stdin.write(DOWN);
  await tick();
  stdin.write("r");
  await tick();
  stdin.write("y");
  await tick();
  assert.match(lastFrame() ?? "", /Working/);
  stdin.write("a");
  await tick();
  assert.doesNotMatch(lastFrame() ?? "", /URL:/);
  release?.();
  await tick();
  assert.match(lastFrame() ?? "", /Refreshed Git Source/);
  unmount();
});

test("App shows key hints and q does not quit while typing or confirming", async () => {
  const h = harness();
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={h.operations} onExit={() => { exits += 1; }} />);
  await tick();
  assert.match(lastFrame() ?? "", /a add/);
  stdin.write("a");
  await tick();
  stdin.write("q");
  await tick();
  assert.equal(exits, 0);
  assert.match(lastFrame() ?? "", /URL: q/);
  stdin.write(ESC);
  await tick();
  stdin.write(DOWN);
  await tick();
  stdin.write("r");
  await tick();
  assert.match(lastFrame() ?? "", /\[y\/n\]/);
  stdin.write("q");
  await tick();
  assert.equal(exits, 0);
  stdin.write("n");
  await tick();
  stdin.write("q");
  await tick();
  assert.equal(exits, 1);
  unmount();
});
