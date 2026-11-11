import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceIdForUrl, type GitSource } from "../src/git-source.js";
import { createSourceRefreshSession, withRefreshSession } from "../src/source-refresh-session.js";
import { BUILT_IN_SOURCE, type SourceOperations, type SourceRefreshOptions } from "../src/sources.js";

const HOUR = 60 * 60 * 1000;

function gitSource(name: string): GitSource {
  const url = `https://github.com/example/${name}.git`;
  return { id: sourceIdForUrl(url), kind: "git", url };
}

interface Call {
  readonly sourceId: string;
  readonly background: boolean;
  resolve(): void;
  reject(error: Error): void;
}

/** Real refreshes are held until the test settles them, so overlap is observable. */
function deferredOperations(sources: readonly GitSource[]) {
  const calls: Call[] = [];
  const start = (sourceId: string, options: SourceRefreshOptions | undefined) => new Promise<void>((resolve, reject) => {
    calls.push({ sourceId, background: options?.background === true, resolve, reject });
  });
  const operations: SourceOperations = {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return [BUILT_IN_SOURCE, ...sources];
    },
    async refreshSource(sourceId, options) {
      await start(sourceId, options);
      return sources.find((source) => source.id === sourceId)!;
    },
    async refreshProjectSource(projectSource, options) {
      if (!("url" in projectSource)) throw new Error("built-in");
      const id = sourceIdForUrl(projectSource.url);
      await start(id, options);
      return sources.find((source) => source.id === id)!;
    },
    async selectSources() {
      return [];
    },
  };
  return { operations, calls };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("concurrent refreshes of one Source share a single real refresh, even when forced", { timeout: 5_000 }, async () => {
  const skills = gitSource("skills");
  const { operations, calls } = deferredOperations([skills]);
  const session = createSourceRefreshSession(operations);

  const first = session.refresh(skills);
  const second = session.refresh(skills);
  const forced = session.refresh(skills, { force: true });
  await settle();
  assert.equal(calls.length, 1);
  calls[0]!.resolve();
  await Promise.all([first, second, forced]);
  assert.equal(calls.length, 1);
});

test("a registered and a project refresh of the same Source share one real refresh through the wrapper", { timeout: 5_000 }, async () => {
  const skills = gitSource("skills");
  const { operations, calls } = deferredOperations([skills]);
  const wrapped = withRefreshSession(operations, createSourceRefreshSession(operations));

  const registered = wrapped.refreshSource(skills.id);
  const project = wrapped.refreshProjectSource!({ kind: "external", url: skills.url, ref: "refs/tags/v1" });
  await settle();
  assert.equal(calls.length, 1);
  calls[0]!.resolve();
  assert.deepEqual(await registered, skills);
  assert.deepEqual(await project, { ...skills, ref: "refs/tags/v1" });
});

test("a successful refresh is reused for one hour unless forced", { timeout: 5_000 }, async () => {
  const skills = gitSource("skills");
  const { operations, calls } = deferredOperations([skills]);
  let clock = 1_000_000;
  const session = createSourceRefreshSession(operations, { now: () => clock });
  const wrapped = withRefreshSession(operations, session);

  const initial = wrapped.refreshSource(skills.id);
  await settle();
  calls[0]!.resolve();
  await initial;

  clock += HOUR - 1;
  await wrapped.refreshSource(skills.id);
  await wrapped.refreshProjectSource!({ kind: "external", url: skills.url });
  assert.equal(calls.length, 1);

  const forced = wrapped.refreshSource(skills.id, { force: true });
  await settle();
  assert.equal(calls.length, 2);
  calls[1]!.resolve();
  await forced;

  clock += HOUR;
  const expired = wrapped.refreshSource(skills.id);
  await settle();
  assert.equal(calls.length, 3);
  calls[2]!.resolve();
  await expired;
});

test("a failed refresh reports its error, is never reused and the next call refreshes again", { timeout: 5_000 }, async () => {
  const skills = gitSource("skills");
  const { operations, calls } = deferredOperations([skills]);
  const session = createSourceRefreshSession(operations, { now: () => 5 });

  const failing = session.refresh(skills);
  await settle();
  calls[0]!.reject(new Error("network down"));
  await assert.rejects(failing, /network down/);
  assert.deepEqual(session.snapshot().get(skills.id), { status: "failed", startedAt: 5, finishedAt: 5, error: "network down" });

  const retry = session.refresh(skills);
  await settle();
  assert.equal(calls.length, 2);
  calls[1]!.resolve();
  await retry;
  assert.deepEqual(session.snapshot().get(skills.id), { status: "refreshed", startedAt: 5, finishedAt: 5 });
});

test("subscribers see each Source move from not refreshed to refreshing to refreshed", { timeout: 5_000 }, async () => {
  const skills = gitSource("skills");
  const { operations, calls } = deferredOperations([skills]);
  let clock = 10;
  const session = createSourceRefreshSession(operations, { now: () => clock });
  const seen: (string | undefined)[] = [session.snapshot().get(skills.id)?.status ?? "not-refreshed"];
  session.subscribe(() => seen.push(session.snapshot().get(skills.id)?.status));

  const pending = session.refresh(skills);
  await settle();
  assert.deepEqual(session.snapshot().get(skills.id), { status: "refreshing", startedAt: 10 });
  clock = 25;
  calls[0]!.resolve();
  await pending;
  assert.deepEqual(seen, ["not-refreshed", "refreshing", "refreshed"]);
  assert.deepEqual(session.snapshot().get(skills.id), { status: "refreshed", startedAt: 10, finishedAt: 25 });
});

test("background refreshes run two at a time without prompts, never reject, and a user refresh does not wait for the queue", { timeout: 5_000 }, async () => {
  const [one, two, three] = [gitSource("one"), gitSource("two"), gitSource("three")];
  const { operations, calls } = deferredOperations([one, two, three]);
  const session = createSourceRefreshSession(operations);

  session.refreshInBackground([one, two, three]);
  await settle();
  assert.deepEqual(calls.map((call) => [call.sourceId, call.background]), [[one.id, true], [two.id, true]]);

  const user = session.refresh(three);
  await settle();
  assert.deepEqual(calls.map((call) => [call.sourceId, call.background]), [[one.id, true], [two.id, true], [three.id, false]]);
  calls[2]!.resolve();
  await user;

  calls[0]!.reject(new Error("timed out"));
  calls[1]!.resolve();
  await settle();
  assert.equal(calls.length, 3, "the queued Source was already refreshed by the user, so the queue skips it");
  assert.equal(session.snapshot().get(one.id)?.status, "failed");
  assert.equal(session.snapshot().get(two.id)?.status, "refreshed");
  assert.equal(session.snapshot().get(three.id)?.status, "refreshed");
});
