import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { sourceIdForUrl, type GitSource } from "../src/git-source.js";
import { createSourceRefreshSession, withRefreshSession } from "../src/source-refresh-session.js";
import { BUILT_IN_SOURCE, type SourceOperations, type SourceRefreshOptions } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { waitForFrame } from "./wait-for-frame.js";
import { confirmAtEnd, PREVIEW_SIZES, resizeTerminal } from "./preview-footer.js";

function gitSource(name: string): GitSource {
  const url = `https://example.test/${name}.git`;
  return { id: sourceIdForUrl(url), kind: "git", url };
}

interface Call {
  readonly sourceId: string;
  readonly background: boolean;
  resolve(): void;
  reject(error: Error): void;
}

/** Real refreshes are held until the test settles them. */
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

const rowOf = (frame: string, source: GitSource) => frame.split("\n").find((line) => line.includes(source.url)) ?? "";

test("each Git Source row carries a textual refresh mark that follows the session live", { timeout: 15_000 }, async () => {
  const [alpha, beta] = [gitSource("alpha"), gitSource("beta")];
  const { operations, calls } = deferredOperations([alpha, beta]);
  let clock = 1_000_000;
  const session = createSourceRefreshSession(operations, { now: () => clock });
  const { lastFrame, stdin, unmount } = render(
    <SourcesView operations={withRefreshSession(operations, session)} refreshSession={session} />,
  );
  let frame = await waitForFrame(lastFrame, (next) => next.includes(beta.url));
  assert.match(rowOf(frame, alpha), /skills\s+https:\/\/example\.test\/alpha\.git\s+· not refreshed/);
  assert.match(rowOf(frame, beta), /· not refreshed/);

  const alphaDone = session.refresh(alpha);
  frame = await waitForFrame(lastFrame, (next) => /… refreshing/.test(rowOf(next, alpha)));
  const betaDone = session.refresh(beta);
  clock += 12_000;
  calls[0]!.resolve();
  await alphaDone;
  frame = await waitForFrame(lastFrame, (next) => /✓ refreshed/.test(rowOf(next, alpha)));
  assert.match(rowOf(frame, beta), /… refreshing 12s/);

  clock += 2 * 60_000;
  calls[1]!.reject(new Error("network down"));
  await assert.rejects(betaDone);
  frame = await waitForFrame(lastFrame, (next) => /✗ refresh failed/.test(rowOf(next, beta)));
  assert.match(rowOf(frame, alpha), /✓ refreshed/);
  assert.doesNotMatch(rowOf(frame, alpha), /ago|just now/);
  assert.doesNotMatch(frame, /network down/, "the error detail belongs to the selected row only");

  stdin.write("j");
  frame = await waitForFrame(lastFrame, /network down/);
  assert.match(frame, /Refresh failed: network down/);
  unmount();
});

test("r in Sources refreshes again even when the Source was refreshed moments ago", { timeout: 15_000 }, async () => {
  const alpha = gitSource("alpha");
  const { operations, calls } = deferredOperations([alpha]);
  const session = createSourceRefreshSession(operations);
  const first = session.refresh(alpha);
  calls[0]!.resolve();
  await first;
  const { lastFrame, stdin, unmount } = render(
    <SourcesView operations={withRefreshSession(operations, session)} refreshSession={session} />,
  );
  await waitForFrame(lastFrame, /✓ refreshed/);

  stdin.write("r");
  await waitForFrame(lastFrame, /Refresh these Sources\? y\/n/);
  stdin.write("y");
  await waitForFrame(lastFrame, () => calls.length === 2);
  assert.equal(calls[1]!.background, false);
  calls[1]!.resolve();
  await waitForFrame(lastFrame, /Refreshed Git Source/);
  unmount();
});

test("App refreshes the registered Git Sources in the background on start without blocking the Sources view", { timeout: 15_000 }, async () => {
  const [alpha, beta, gamma] = [gitSource("alpha"), gitSource("beta"), gitSource("gamma")];
  const { operations, calls } = deferredOperations([alpha, beta, gamma]);
  const session = createSourceRefreshSession(operations);
  const { lastFrame, unmount } = render(<App operations={operations} refreshSession={session} refreshOnStart />);

  let frame = await waitForFrame(lastFrame, (next) => /… refreshing/.test(rowOf(next, alpha)) && next.includes(gamma.url));
  assert.match(rowOf(frame, gamma), /· not refreshed/, "only two background refreshes run at once");
  assert.deepEqual(calls.map((call) => [call.sourceId, call.background]), [[alpha.id, true], [beta.id, true]]);

  calls[0]!.resolve();
  frame = await waitForFrame(lastFrame, (next) => /✓ refreshed/.test(rowOf(next, alpha)) && /… refreshing/.test(rowOf(next, gamma)));
  calls[1]!.reject(new Error("timed out"));
  calls[2]!.resolve();
  frame = await waitForFrame(lastFrame, (next) => /✗ refresh failed/.test(rowOf(next, beta)) && /✓ refreshed/.test(rowOf(next, gamma)));
  unmount();
});

test("App starts no refresh unless asked to", { timeout: 15_000 }, async () => {
  const alpha = gitSource("alpha");
  const { operations, calls } = deferredOperations([alpha]);
  const session = createSourceRefreshSession(operations);
  const { lastFrame, unmount } = render(<App operations={operations} refreshSession={session} />);
  await waitForFrame(lastFrame, /· not refreshed/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 0);
  unmount();
});

for (const size of PREVIEW_SIZES) {
  test(`refreshing marked Sources accepts y exactly when the footer reads to the end at ${size.columns}x${size.rows}`, { timeout: 30_000 }, async () => {
    const sources = Array.from({ length: 30 }, (_, index) => gitSource(`source-${String(index).padStart(2, "0")}`));
    const { operations, calls } = deferredOperations(sources);
    const view = render(<SourcesView operations={operations} listHeight={5} />);
    await waitForFrame(view.lastFrame, /source-00/);
    resizeTerminal(view, size);
    view.stdin.write("a");
    await waitForFrame(view.lastFrame, /30 selected/);
    view.stdin.write("r");
    await confirmAtEnd(view, size.rows, /\[y\] Refresh 30 Sources/, () => calls.length > 0);
    for (const call of calls) call.resolve();
    view.unmount();
  });
}
