import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceIdForUrl, type GitSource } from "../src/git-source.js";
import { createSourceRefreshSession } from "../src/source-refresh-session.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { finishRunningRefreshes } from "../src/tui/render.js";

const url = "https://github.com/example/quit.git";
const source: GitSource = { id: sourceIdForUrl(url), kind: "git", url };
const WAITING_MESSAGE = "Waiting for the Source refreshes still running to finish…\n";

/** Refreshes stay pending until `finish` is called, so a refresh can be running when the TUI exits. */
function heldRefreshes() {
  const finishers: Array<() => void> = [];
  const hold = () => new Promise<GitSource>((resolve) => {
    finishers.push(() => resolve(source));
  });
  const operations: SourceOperations = {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return [BUILT_IN_SOURCE, source];
    },
    refreshSource: hold,
    refreshProjectSource: hold,
    async selectSources() {
      throw new Error("unused");
    },
  };
  return { operations, finishAll: () => finishers.forEach((finish) => finish()) };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("quitting waits for a running Source refresh and says so", async () => {
  const { operations, finishAll } = heldRefreshes();
  const session = createSourceRefreshSession(operations);
  session.refreshInBackground([source]);
  const messages: string[] = [];
  let done = false;

  const finishing = finishRunningRefreshes(session, (message) => messages.push(message)).then(() => {
    done = true;
  });
  await tick();
  assert.deepEqual(messages, [WAITING_MESSAGE]);
  assert.equal(done, false);

  finishAll();
  await finishing;
  assert.equal(done, true);
});

test("quitting with no Source refresh running neither waits nor prints", async () => {
  const { operations } = heldRefreshes();
  const session = createSourceRefreshSession(operations);
  const messages: string[] = [];

  await finishRunningRefreshes(session, (message) => messages.push(message));

  assert.deepEqual(messages, []);
});

test("quitting after the Source refreshes finished neither waits nor prints", async () => {
  const { operations, finishAll } = heldRefreshes();
  const session = createSourceRefreshSession(operations);
  session.refreshInBackground([source]);
  const messages: string[] = [];
  finishAll();
  await session.settled();

  await finishRunningRefreshes(session, (message) => messages.push(message));

  assert.deepEqual(messages, []);
});
