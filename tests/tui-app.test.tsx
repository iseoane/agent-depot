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

test("App renders the header and the Sources placeholder", () => {
  const { lastFrame, unmount } = render(<App operations={operations} onExit={() => undefined} />);
  assert.match(lastFrame() ?? "", /Agent Depot/);
  assert.match(lastFrame() ?? "", /Sources/);
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
