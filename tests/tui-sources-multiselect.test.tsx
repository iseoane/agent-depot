import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import type { GitSource } from "../src/git-source.js";
import { BUILT_IN_SOURCE, type Source, type SourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const first: GitSource = { id: "git:1111111111111111aaaaaaaa", kind: "git", url: "https://github.com/example/one.git" };
const second: GitSource = { id: "git:2222222222222222bbbbbbbb", kind: "git", url: "https://github.com/example/two.git" };
const third: GitSource = { id: "git:3333333333333333cccccccc", kind: "git", url: "https://github.com/example/three.git" };

const DOWN = "\u001B[B";
const UP = "\u001B[A";

function operationsFor(calls: string[], failing: readonly string[] = []): SourceOperations {
  const sources: readonly Source[] = [BUILT_IN_SOURCE, first, second, third];
  return {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return sources;
    },
    async refreshSource(id) {
      calls.push(`refresh ${id}`);
      if (failing.includes(id)) throw new Error(`cannot reach ${id}`);
      return sources.find((source) => source.id === id) as GitSource;
    },
    async selectSources() {
      return [];
    },
  };
}

async function open(operations: SourceOperations) {
  const view = render(<SourcesView operations={operations} />);
  await waitForFrame(view.lastFrame, /builtin:agent-depot/);
  return view;
}

const lineOf = (frame: string, id: string) => frame.split("\n").find((line) => line.includes(id)) ?? "";
const highlighted = (frame: string) => frame.split("\n").find((line) => line.startsWith("> ")) ?? "";

test("the header row is outside the list and never highlighted", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  let frame = await waitForFrame(lastFrame, /ID\s+KIND\s+URL/);
  assert.match(highlighted(frame), new RegExp(first.id));
  assert.doesNotMatch(lineOf(frame, "KIND"), /^>/);
  stdin.write(UP);
  stdin.write(UP);
  frame = await waitForFrame(lastFrame, /ID\s+KIND\s+URL/);
  assert.match(highlighted(frame), new RegExp(first.id));
  assert.equal(frame.split("\n").filter((line) => line.startsWith("> ")).length, 1);
  unmount();
});

test("space toggles the highlighted source and markers show the selection", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  stdin.write(" ");
  let frame = await waitForFrame(lastFrame, (candidate) => /\[x\]/.test(lineOf(candidate, first.id)));
  assert.match(lineOf(frame, second.id), /\[ \]/);
  assert.match(frame, /1 selected/);
  stdin.write(" ");
  frame = await waitForFrame(lastFrame, (candidate) => /\[ \]/.test(lineOf(candidate, first.id)));
  assert.doesNotMatch(frame, /selected/);
  unmount();
});

test("a toggles all Git sources and never marks the built-in source", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  stdin.write("a");
  let frame = await waitForFrame(lastFrame, (candidate) => [first, second, third].every((source) => /\[x\]/.test(lineOf(candidate, source.id))));
  assert.doesNotMatch(lineOf(frame, "builtin:agent-depot"), /\[x\]/);
  assert.match(frame, /3 selected/);
  stdin.write("a");
  frame = await waitForFrame(lastFrame, (candidate) => [first, second, third].every((source) => /\[ \]/.test(lineOf(candidate, source.id))));
  assert.doesNotMatch(frame, /selected/);
  unmount();
});

test("r refreshes the selected sources with one combined preview and one confirmation", async () => {
  const calls: string[] = [];
  const { lastFrame, stdin, unmount } = await open(operationsFor(calls));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  stdin.write(" ");
  await waitForFrame(lastFrame, /1 selected/);
  stdin.write(DOWN);
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(second.id));
  stdin.write(DOWN);
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(third.id));
  stdin.write(" ");
  await waitForFrame(lastFrame, /2 selected/);
  stdin.write("r");
  const preview = await waitForFrame(lastFrame, /\[y\/n\]/);
  assert.match(preview, new RegExp(`${first.id}.*${first.url.replaceAll(".", "\\.")}`));
  assert.match(preview, new RegExp(`${third.id}.*${third.url.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(preview.slice(preview.indexOf("selected")), new RegExp(second.id));
  assert.equal(preview.match(/\[y\/n\]/g)?.length, 1);
  assert.deepEqual(calls, []);
  stdin.write("y");
  const frame = await waitForFrame(lastFrame, (candidate) => candidate.includes(`Refreshed Git Source: ${first.id}`) && candidate.includes(`Refreshed Git Source: ${third.id}`));
  assert.deepEqual(calls, [`refresh ${first.id}`, `refresh ${third.id}`]);
  assert.doesNotMatch(frame, /selected/);
  unmount();
});

test("one failing refresh does not stop the others and is reported with its reason", async () => {
  const calls: string[] = [];
  const { lastFrame, stdin, unmount } = await open(operationsFor(calls, [first.id]));
  stdin.write("a");
  await waitForFrame(lastFrame, /3 selected/);
  stdin.write("r");
  await waitForFrame(lastFrame, /\[y\/n\]/);
  stdin.write("y");
  const frame = await waitForFrame(lastFrame, (candidate) => candidate.includes(`Refreshed Git Source: ${third.id}`));
  assert.deepEqual(calls, [`refresh ${first.id}`, `refresh ${second.id}`, `refresh ${third.id}`]);
  assert.match(frame, new RegExp(`Failed ${first.id}: cannot reach ${first.id}`));
  assert.match(frame, new RegExp(`Refreshed Git Source: ${second.id}`));
  unmount();
});

test("r without a selection refreshes the highlighted source", async () => {
  const calls: string[] = [];
  const { lastFrame, stdin, unmount } = await open(operationsFor(calls));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  stdin.write("r");
  await waitForFrame(lastFrame, /\[y\/n\]/);
  stdin.write("y");
  await waitForFrame(lastFrame, new RegExp(`Refreshed Git Source: ${first.id}`));
  assert.deepEqual(calls, [`refresh ${first.id}`]);
  unmount();
});

test("d stays single-source even with a selection", async () => {
  const removals: string[] = [];
  const operations: SourceOperations = {
    ...operationsFor([]),
    async listUserGlobalInstallations() {
      return [];
    },
    async removeGitSource(id: string) {
      removals.push(id);
    },
  };
  const { lastFrame, stdin, unmount } = await open(operations);
  stdin.write("a");
  await waitForFrame(lastFrame, /3 selected/);
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  stdin.write("d");
  const preview = await waitForFrame(lastFrame, /\[y\/n\]/);
  assert.match(preview, new RegExp(`remove Git Source ${first.id}`));
  assert.doesNotMatch(preview.slice(preview.indexOf("selected")), new RegExp(second.id));
  stdin.write("y");
  await waitForFrame(lastFrame, /Removed Git Source/);
  assert.deepEqual(removals, [first.id]);
  unmount();
});

test("keys sent in one burst move and mark against the latest state", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  for (const data of ["j", "j", " "]) stdin.write(data);
  const frame = await waitForFrame(lastFrame, (candidate) => /\[x\]/.test(lineOf(candidate, third.id)));
  assert.match(frame, /1 selected/);
  assert.match(lineOf(frame, first.id), /\[ \]/);
  assert.match(highlighted(frame), new RegExp(third.id));
  unmount();
});

test("space, j, space in one burst marks two sources", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  for (const data of [" ", "j", " "]) stdin.write(data);
  const frame = await waitForFrame(lastFrame, (candidate) => /2 selected/.test(candidate));
  assert.match(lineOf(frame, first.id), /\[x\]/);
  assert.match(lineOf(frame, second.id), /\[x\]/);
  unmount();
});

test("a then r in one burst previews every marked source", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  stdin.write("a");
  stdin.write("r");
  const frame = await waitForFrame(lastFrame, /\[y\/n\]/);
  for (const source of [first, second, third]) assert.match(frame, new RegExp(`refresh Git Source ${source.id}`));
  unmount();
});

test("j, j, r in one burst previews the source the highlight reached", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  for (const data of ["j", "j", "r"]) stdin.write(data);
  const frame = await waitForFrame(lastFrame, /\[y\/n\]/);
  assert.match(frame, new RegExp(`refresh Git Source ${third.id}`));
  assert.doesNotMatch(frame, new RegExp(`refresh Git Source ${first.id}`));
  unmount();
});

test("several keys delivered in a single write are handled one by one", async () => {
  const { lastFrame, stdin, unmount } = await open(operationsFor([]));
  await waitForFrame(lastFrame, (frame) => highlighted(frame).includes(first.id));
  stdin.write("jj ");
  const frame = await waitForFrame(lastFrame, (candidate) => /\[x\]/.test(lineOf(candidate, third.id)));
  assert.match(frame, /1 selected/);
  unmount();
});
