import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";

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

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("App renders the header and the Sources view", async () => {
  const { lastFrame, unmount } = render(<App operations={operations} onExit={() => undefined} />);
  await tick();
  assert.match(lastFrame() ?? "", /Agent Depot/);
  assert.match(lastFrame() ?? "", /Sources/);
  assert.match(lastFrame() ?? "", /builtin:agent-depot/);
  unmount();
});

test("App calls onExit when q is pressed", async () => {
  let exits = 0;
  const { stdin, unmount } = render(<App operations={operations} onExit={() => { exits += 1; }} />);
  await new Promise((resolve) => setImmediate(resolve));
  stdin.write("q");
  await new Promise((resolve) => setImmediate(resolve));
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("App switches views with 1 and 2 and shows the active view", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  await settle();
  assert.match(lastFrame() ?? "", /\[1 Sources\]/);
  stdin.write("2");
  await settle();
  assert.match(lastFrame() ?? "", /\[2 Catalog\]/);
  assert.match(lastFrame() ?? "", /skill-of-/);
  stdin.write("1");
  await settle();
  assert.match(lastFrame() ?? "", /\[1 Sources\]/);
  unmount();
});

test("App opens the catalog of the highlighted source with Enter", async () => {
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} />);
  await settle();
  stdin.write("j");
  await settle();
  stdin.write("\r");
  await settle();
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[2 Catalog\]/);
  assert.match(frame, /skill-of-git:1234567890abcdef12345678/);
  assert.ok(!frame.includes("skill-of-builtin"));
  unmount();
});

test("App does not switch views or quit while the catalog filter captures keys", async () => {
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} onExit={() => { exits += 1; }} />);
  await settle();
  stdin.write("2");
  await settle();
  stdin.write("/");
  await settle();
  stdin.write("q1");
  await settle();
  assert.equal(exits, 0);
  assert.match(lastFrame() ?? "", /\[2 Catalog\]/);
  assert.match(lastFrame() ?? "", /Filter: q1/);
  unmount();
});

test("App ignores q and view keys sent in the same burst as the catalog filter key", async () => {
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(<App operations={catalogOperations} onExit={() => { exits += 1; }} />);
  await settle();
  stdin.write("2");
  await settle();
  stdin.write("/");
  stdin.write("q");
  stdin.write("1");
  await settle();
  assert.equal(exits, 0);
  assert.match(lastFrame() ?? "", /\[2 Catalog\]/);
  assert.match(lastFrame() ?? "", /Filter: q1/);
  unmount();
});

test("App keeps q, 1 and 2 inert while the Catalog install flow captures keys", async () => {
  let exits = 0;
  const { stdin, lastFrame, unmount } = render(<App operations={catalogOperations} onExit={() => { exits += 1; }} />);
  await settle();
  stdin.write("2");
  await settle();
  stdin.write("i");
  await settle();
  assert.match(lastFrame() ?? "", /Host/);
  for (const input of ["q", "1", "2"]) {
    stdin.write(input);
    await settle();
  }
  assert.equal(exits, 0);
  assert.match(lastFrame() ?? "", /2 Catalog\]/);
  assert.match(lastFrame() ?? "", /space toggle/);
  stdin.write("\u001B");
  await settle();
  stdin.write("q");
  await settle();
  assert.equal(exits, 1);
  unmount();
});
