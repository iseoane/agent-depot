import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProjectSource } from "../src/project-manifest.js";
import { buildUpdateTree, groupCheckState, packageLeafLabel, toggleGroup, type UpdateNode } from "../src/tui/updates-tree.js";
import type { UpdateRow } from "../src/tui/updates.js";

const GIT: ProjectSource = { kind: "external", url: "https://example.test/b.git" };
const OTHER: ProjectSource = { kind: "external", url: "https://example.test/a.git", ref: "next" };
const BUILTIN: ProjectSource = { kind: "builtin", id: "builtin:agent-depot" };

const skill = (key: string, source: ProjectSource): UpdateRow =>
  ({ kind: "skill", key, scope: "project", item: { selection: { source, path: key } } }) as unknown as UpdateRow;
const pkg = (key: string, source: ProjectSource, coordinates: object): UpdateRow =>
  ({ kind: "package", key, scope: "user-global", check: { installed: { selection: { source, ...coordinates } } } }) as unknown as UpdateRow;
const app = (key: string): UpdateRow => ({ kind: "app", key, scope: "user-global" }) as unknown as UpdateRow;

const ROWS = [
  skill("project:skills/x", GIT),
  app("app:one.json"),
  pkg('package:["b","pi"]', GIT, { host: "pi", root: "plugins/p" }),
  skill("project:skills/y", OTHER),
  skill("project:skills/z", GIT),
];

const outline = (nodes: readonly UpdateNode[]): unknown[] => nodes.map((node) =>
  node.data.kind === "group" ? [node.data.label, outline(node.children ?? [])] : (node.data as { row: UpdateRow }).row.key);
const allIds = (nodes: readonly UpdateNode[]): string[] => nodes.flatMap((node) => [node.id, ...allIds(node.children ?? [])]);

test("the tree is Sources by label, Packages before Skills, then Apps last", () => {
  assert.deepEqual(outline(buildUpdateTree(ROWS)), [
    ["https://example.test/a.git@next (1)", [["Skills (1)", ["project:skills/y"]]]],
    ["https://example.test/b.git (3)", [["Packages (1)", ['package:["b","pi"]']], ["Skills (2)", ["project:skills/x", "project:skills/z"]]]],
    ["Apps (1)", ["app:one.json"]],
  ]);
});

test("a group knows the keys of the rows below it", () => {
  const [, second] = buildUpdateTree(ROWS);
  assert.deepEqual(second!.data.kind === "group" && second!.data.leafKeys, ['package:["b","pi"]', "project:skills/x", "project:skills/z"]);
});

test("node ids are unique and carry no path separator", () => {
  const ids = allIds(buildUpdateTree(ROWS));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length > 5);
  for (const id of ids) assert.doesNotMatch(id, /[\\/]/u, id);
});

test("no updates gives an empty tree", () => {
  assert.deepEqual(buildUpdateTree([]), []);
  assert.deepEqual(outline(buildUpdateTree([skill("a", BUILTIN)])), [["builtin:agent-depot (1)", [["Skills (1)", ["a"]]]]]);
});

test("a group is checked, partly checked or unchecked by its own rows", () => {
  assert.equal(groupCheckState(["a", "b"], ["a", "b", "c"]), "all");
  assert.equal(groupCheckState(["a", "b"], ["b", "c"]), "some");
  assert.equal(groupCheckState(["a", "b"], ["c"]), "none");
  assert.equal(groupCheckState([], ["c"]), "none");
});

test("toggling a group selects the missing rows, or unselects only its rows when all are selected", () => {
  assert.deepEqual([...toggleGroup(["c"], ["a", "b"])].sort(), ["a", "b", "c"]);
  assert.deepEqual([...toggleGroup(["b", "c"], ["a", "b"])].sort(), ["a", "b", "c"]);
  assert.deepEqual([...toggleGroup(["a", "b", "c"], ["a", "b"])], ["c"]);
});

test("a Package leaf shows its name and its path only when it is not the Source root", () => {
  assert.equal(packageLeafLabel(pkg("k", GIT, { host: "pi", root: "plugins/pstack" })), "Package: pstack  plugins/pstack");
  assert.equal(packageLeafLabel(pkg("k", GIT, { host: "claude", marketplaceRoot: "", pluginName: "demo" })), "Package: demo");
  assert.equal(packageLeafLabel(pkg("k", GIT, { host: "claude", marketplaceRoot: "market", pluginName: "demo" })), "Package: demo  market");
  assert.equal(packageLeafLabel(pkg("k", GIT, { host: "pi", root: "" })), "Package: pi package");
  for (const coordinates of [{ host: "pi", root: "" }, { host: "claude", marketplaceRoot: "", pluginName: "demo" }]) {
    assert.doesNotMatch(packageLeafLabel(pkg("k", GIT, coordinates)), /\.|@/u);
  }
});
