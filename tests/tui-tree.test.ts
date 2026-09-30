import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collapseOrParent,
  defaultExpanded,
  expandNode,
  flattenVisible,
  resolveSelection,
  toggleNode,
  type TreeNode,
} from "../src/tui/tree.js";

const roots: readonly TreeNode<string>[] = [
  {
    id: "a",
    data: "A",
    children: [
      { id: "a/x", data: "AX", children: [{ id: "a/x/1", data: "AX1" }, { id: "a/x/2", data: "AX2" }] },
      { id: "a/y", data: "AY", children: [{ id: "a/y/1", data: "AY1" }] },
    ],
  },
  { id: "b", data: "B", children: [{ id: "b/1", data: "B1" }] },
  { id: "c", data: "C" },
];

const ids = (rows: ReturnType<typeof flattenVisible<string>>) => rows.map((row) => row.node.id);

test("groups start collapsed except the first", () => {
  assert.deepEqual([...defaultExpanded(roots)], ["a"]);
  assert.deepEqual(ids(flattenVisible(roots, defaultExpanded(roots))), ["a", "a/x", "a/y", "b", "c"]);
});

test("the default expansion skips leading empty groups", () => {
  const empty: readonly TreeNode<string>[] = [{ id: "e", data: "E", children: [] }, ...roots];
  assert.deepEqual([...defaultExpanded(empty)], ["a"]);
});

test("flattenVisible reports depth, parent, expandability and state", () => {
  const rows = flattenVisible(roots, new Set(["a", "a/x"]));
  assert.deepEqual(rows.map((row) => [row.node.id, row.depth, row.parentId, row.expandable, row.expanded]), [
    ["a", 0, undefined, true, true],
    ["a/x", 1, "a", true, true],
    ["a/x/1", 2, "a/x", false, false],
    ["a/x/2", 2, "a/x", false, false],
    ["a/y", 1, "a", true, false],
    ["b", 0, undefined, true, false],
    ["c", 0, undefined, false, false],
  ]);
});

test("expand, toggle and collapse never mutate the input and ignore leaves", () => {
  const start: ReadonlySet<string> = new Set(["a"]);
  const rows = flattenVisible(roots, start);
  const expanded = expandNode(start, rows[1]!);
  assert.deepEqual([...expanded].sort(), ["a", "a/x"]);
  assert.deepEqual([...start], ["a"]);
  assert.equal(expandNode(start, rows[4]!), start, "a leaf cannot expand");
  assert.deepEqual([...toggleNode(expanded, flattenVisible(roots, expanded)[1]!)], ["a"]);
  assert.deepEqual([...toggleNode(start, rows[3]!)].sort(), ["a", "b"]);
});

test("collapseOrParent collapses an open node, else moves selection to the parent", () => {
  const open = new Set(["a", "a/x"]);
  const rows = flattenVisible(roots, open);
  assert.deepEqual(collapseOrParent(open, rows, 1), { expanded: new Set(["a"]), selectedId: "a/x" });
  const leaf = collapseOrParent(open, rows, 2);
  assert.equal(leaf.selectedId, "a/x");
  assert.equal(leaf.expanded, open);
  const top = collapseOrParent(new Set<string>(), flattenVisible(roots, new Set()), 0);
  assert.equal(top.selectedId, "a");
});

test("resolveSelection follows the stable id, else falls back to the bounded index", () => {
  const rows = flattenVisible(roots, new Set(["a", "a/x"]));
  assert.equal(resolveSelection(rows, { id: "a/y", index: 0 }), 4);
  assert.equal(resolveSelection(rows, { id: "gone", index: 99 }), rows.length - 1);
  assert.equal(resolveSelection(rows, { index: 2 }), 2);
  assert.equal(resolveSelection([], { id: "x", index: 3 }), 0);
});

test("selection survives collapsing an ancestor by moving to it", () => {
  const open = new Set(["a", "a/x"]);
  const before = flattenVisible(roots, open);
  const parent = collapseOrParent(open, before, 2);
  const after = flattenVisible(roots, parent.expanded);
  assert.equal(after[resolveSelection(after, { id: parent.selectedId, index: 2 })]!.node.id, "a/x");
});
