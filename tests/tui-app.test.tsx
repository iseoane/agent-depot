import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { AGENT_DEPOT_PACKAGE_VERSION, ProjectManifestStore } from "../src/project-manifest.js";
import { BUILT_IN_SOURCE, createSourceOperations, type Source, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const external = {
  id: "git:1234567890abcdef12345678",
  kind: "git" as const,
  url: "https://github.com/example/skills.git",
};

const operations: SourceOperations = {
  async addGitSource() {
    return external;
  },
  async listSources() {
    return [BUILT_IN_SOURCE];
  },
  async refreshSource() {
    return external;
  },
  async selectSources() {
    return [BUILT_IN_SOURCE];
  },
};

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("App renders the header and the Sources view", async () => {
  const { lastFrame, unmount } = render(<App operations={operations} onExit={() => undefined} />);
  const frame = await waitForFrame(lastFrame, /builtin:agent-depot/);
  assert.match(frame, /Agent Depot/);
  assert.match(frame, /Sources/);
  unmount();
});

test("App fills its startup screen and tracks terminal resize while Sources is loading", async () => {
  let finishLoading: ((sources: readonly Source[]) => void) | undefined;
  const loadingOperations: SourceOperations = {
    ...operations,
    listSources: () => new Promise((resolve) => { finishLoading = resolve; }),
  };
  const { lastFrame, stdout, unmount } = render(<App operations={loadingOperations} />);
  try {
    const initial = await waitForFrame(lastFrame, /Loading sources/);
    assert.equal(initial.split("\n").length, 24, "the loading screen occupies Ink's default 24-row viewport");
    Object.defineProperty(stdout, "rows", { configurable: true, value: 12 });
    Object.defineProperty(stdout, "columns", { configurable: true, value: 40 });
    stdout.emit("resize");
    const resized = await waitForFrame(lastFrame, (frame) => frame.split("\n").length === 12);
    assert.equal(resized.split("\n").find((line) => line.includes("═"))?.trim().length, 40);
    finishLoading?.([BUILT_IN_SOURCE]);
    const ready = await waitForFrame(lastFrame, /builtin:agent-depot/);
    assert.equal(ready.split("\n").length, 12, "the loaded view keeps filling the resized viewport");
  } finally {
    unmount();
  }
});

test("App shows the package version in the header", async () => {
  const { lastFrame, unmount } = render(<App operations={operations} onExit={() => undefined} />);
  const frame = await waitForFrame(lastFrame, /builtin:agent-depot/);
  assert.ok(frame.includes(`Agent Depot v${AGENT_DEPOT_PACKAGE_VERSION}`), frame);
  unmount();
});

test("App calls onExit when q is pressed", async () => {
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={operations} onExit={() => { exits += 1; }} />);
  // Wait for the first render so the key handler is attached, then poll for the exit call.
  await waitForFrame(lastFrame, /builtin:agent-depot/);
  stdin.write("q");
  await waitFor(() => exits === 1);
  assert.equal(exits, 1);
  unmount();
});

const catalogOperations: SourceOperations = {
  ...operations,
  async listSources() {
    return [BUILT_IN_SOURCE, external];
  },
  async discoverSkills(ids) {
    return ids.map((sourceId) => ({ sourceId, path: `p-${sourceId}`, name: `skill-of-${sourceId}`, description: "d" }));
  },
};

test("App switches views with 1 and 2 and shows the active view", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("2");
  await waitForFrame(lastFrame, (frame) => /\[2 Catalog\]/.test(frame) && /▸ builtin:agent-depot/.test(frame));
  stdin.write("\r");
  await waitForFrame(lastFrame, /skill-of-builtin/);
  stdin.write("1");
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  unmount();
});

test("App opens the catalog of the highlighted source with Enter", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  await waitForFrame(lastFrame, /git:1234567890abcdef12345678/);
  stdin.write("j");
  await waitForFrame(lastFrame, (frame) => /> (\[.\] )?git:1234567890abcdef12345678/.test(frame));
  stdin.write("\r");
  await waitForFrame(lastFrame, /▸ example\/skills/);
  stdin.write("\r");
  const frame = await waitForFrame(lastFrame, /skill-of-git:1234567890abcdef12345678/);
  assert.match(frame, /\[2 Catalog\]/);
  assert.ok(!frame.includes("skill-of-builtin"));
  unmount();
});

test("App does not switch views or quit while the catalog filter captures keys", async () => {
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} onExit={() => { exits += 1; }} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("2");
  await waitForFrame(lastFrame, /\[2 Catalog\]/);
  stdin.write("/");
  await waitForFrame(lastFrame, /Filter: _/);
  stdin.write("q1");
  // Typing is processed in order, so once the filter shows the text the keys were captured, not treated as q / view 1.
  const frame = await waitForFrame(lastFrame, /Filter: q1/);
  assert.equal(exits, 0);
  assert.match(frame, /\[2 Catalog\]/);
  unmount();
});

test("App ignores q and view keys sent in the same burst as the catalog filter key", async () => {
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} onExit={() => { exits += 1; }} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("2");
  await waitForFrame(lastFrame, /\[2 Catalog\]/);
  stdin.write("/");
  stdin.write("q");
  stdin.write("1");
  const frame = await waitForFrame(lastFrame, /Filter: q1/);
  assert.equal(exits, 0);
  assert.match(frame, /\[2 Catalog\]/);
  unmount();
});

test("App views render with the real source operations on a temporary home", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-smoke-"));
  try {
    const environment: TuiEnvironment = {
      homeDirectory: home,
      projectManifestStore: new ProjectManifestStore(path.join(home, "project", "agent-depot.json")),
    };
    const real = createSourceOperations({ homeDirectory: home });
    const { lastFrame, stdin, unmount } = render(<App operations={real} environment={environment} />);
    await waitForFrame(lastFrame, /builtin:agent-depot/);
    const views: [string, RegExp][] = [
      ["2", /\[2 Catalog\]/],
      ["3", /\[3 Installations\]/],
      ["4", /\[4 Updates\]/],
      ["5", /\[5 Import\/Export\]/],
      ["1", /\[1 Sources\]/],
    ];
    for (const [key, header] of views) {
      stdin.write(key);
      // Wait until the view finished loading (or failed), then require that it did not fail.
      const frame = await waitForFrame(lastFrame, (candidate) => header.test(candidate) && !/Loading|Checking|Refreshing/.test(candidate));
      assert.doesNotMatch(frame, /Cannot read properties|TypeError|Error:/);
    }
    unmount();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("App separates the header and tab bar from the page with a double line", async () => {
  const { lastFrame, unmount } = render(<App operations={operations} onExit={() => undefined} />);
  const frame = await waitForFrame(lastFrame, /builtin:agent-depot/);
  const lines = frame.split("\n");
  const tabs = lines.findIndex((line) => line.includes("1 Sources"));
  const separator = lines.findIndex((line) => /^═{20,}$/.test(line.trim()));
  const page = lines.findIndex((line) => line.includes("builtin:agent-depot"));
  assert.ok(tabs >= 0 && separator > tabs && page > separator, `unexpected layout:\n${frame}`);
  unmount();
});

test("App footer for the Catalog offers install only", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("2");
  const frame = await waitForFrame(lastFrame, /\[2 Catalog\]/);
  assert.match(frame, /i install/);
  assert.match(frame, /Enter expand/);
  assert.doesNotMatch(frame, /uninstall|add hosts/);
  unmount();
});

/** The last non-empty line of the frame, where the shell prints the key hints. */
function footerOf(frame: string): string {
  return frame.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
}

test("no footer repeats the view-switch hints the tab bar already shows, and each names its own keys", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  const expected: [string | undefined, RegExp, RegExp][] = [
    [undefined, /\[1 Sources\]/, /space mark.*a all.*Enter catalog.*n add.*r refresh.*d remove/],
    ["2", /\[2 Catalog\]/, /space mark.*a repo.*i install.*\/ filter/],
    ["3", /\[3 Installations\]/, /space mark.*a all.*u uninstall.*h add hosts.*A adopt/],
    ["4", /\[4 Updates\]/, /space mark.*a all.*Enter preview.*r check again/],
  ];
  for (const [key, tab, keys] of expected) {
    if (key !== undefined) stdin.write(key);
    const frame = await waitForFrame(lastFrame, tab);
    const footer = footerOf(await waitForFrame(lastFrame, (candidate) => keys.test(footerOf(candidate))));
    assert.match(footer, /j\/k move/);
    assert.match(footer, /q quit/);
    assert.doesNotMatch(footer, /\b[1-4] (sources|catalog|installations|updates)\b/i, `view-switch hint in: ${footer}\n${frame}`);
  }
  unmount();
});

test("the number keys still switch views", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  for (const [key, tab] of [["2", /\[2 Catalog\]/], ["3", /\[3 Installations\]/], ["1", /\[1 Sources\]/], ["4", /\[4 Updates\]/]] as const) {
    stdin.write(key);
    await waitForFrame(lastFrame, tab);
  }
  unmount();
});

test("key 5 opens Profile actions", async () => {
  const view = render(<App operations={operations} />);
  await waitForFrame(view.lastFrame, /builtin:agent-depot/);
  view.stdin.write("5");
  await waitForFrame(view.lastFrame, /e export.*i import/);
  view.unmount();
});
