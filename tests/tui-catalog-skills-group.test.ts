import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceIdForUrl } from "../src/git-source.js";
import { packageSelectionFor, type BundleDescriptor } from "../src/package-model.js";
import { projectSourceOf } from "../src/sources.js";
import { buildTree, describeRow, leavesOf, looseLeavesOf, openByDefault, type BundleEntry } from "../src/tui/catalog-tree.js";
import { flattenVisible } from "../src/tui/tree.js";

const source = { id: sourceIdForUrl("https://github.com/example/skills"), kind: "git" as const, url: "https://github.com/example/skills" };
const mk = (path: string, name: string) => ({ sourceId: source.id, path, name, description: "d" });

function bundleEntry(): BundleEntry {
  const descriptor: BundleDescriptor = {
    host: "claude",
    coordinates: { host: "claude", marketplaceRoot: "", pluginName: "plug" },
    name: "plug",
    components: [],
    warnings: [],
    installable: true,
    manifestDigest: "a".repeat(64),
  };
  return { sourceId: source.id, selection: packageSelectionFor(descriptor, projectSourceOf(source)), descriptor };
}

test("a Catalog Source lists its Skills in a collapsible Skills (N) group next to Packages (N)", () => {
  const tree = buildTree([mk("a/one", "one"), mk("b/two", "two")], [source], [bundleEntry()], []);
  const root = `source:${source.id}`;
  assert.deepEqual(tree[0]!.children!.map((node) => node.id), [`packages:${source.id}`, `skills:${source.id}`]);
  const collapsed = flattenVisible(tree, new Set([root])).slice(1).map(describeRow);
  assert.deepEqual(collapsed, ["▸ Packages (1)", "▸ Skills (2)"]);
  const open = flattenVisible(tree, new Set([root, `skills:${source.id}`])).slice(1).map(describeRow);
  assert.deepEqual(open, ["▸ Packages (1)", "▾ Skills (2)", "one  d", "two  d"]);
});

test("a Source with only Skills still gets the Skills group, keeping variants inside it with unique ids and correct leaves", () => {
  const skills = [mk("a/imp", "imp"), mk("b/imp", "imp"), mk("c/solo", "solo")];
  const tree = buildTree(skills, [source]);
  const root = `source:${source.id}`;
  const group = `skills:${source.id}`;
  const variants = `variants:${source.id}:imp`;
  const rows = flattenVisible(tree, new Set([root, group, variants]));
  assert.deepEqual(rows.slice(1).map(describeRow), [
    "▾ Skills (3)", "▾ imp (2 variants)", "imp  d  (a/imp)", "imp  d  (b/imp)", "solo  d",
  ]);
  const ids = rows.map((row) => row.node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(leavesOf(tree).map((skill) => skill.path), ["a/imp", "b/imp", "c/solo"]);
  assert.deepEqual(looseLeavesOf(tree).map((skill) => skill.path), ["a/imp", "b/imp", "c/solo"]);
  assert.equal((tree[0]!.data as { count: number }).count, 3);
});

test("filtering opens the Skills group and its variants; no filter leaves them collapsed", () => {
  const tree = buildTree([mk("a/imp", "imp"), mk("b/imp", "imp")], [source]);
  const filtered = openByDefault(tree, "imp");
  assert.ok(filtered.has(`skills:${source.id}`));
  assert.ok(filtered.has(`variants:${source.id}:imp`));
  assert.equal(openByDefault(tree, "").size, 0);
});
