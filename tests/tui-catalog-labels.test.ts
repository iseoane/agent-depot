import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceIdForUrl } from "../src/git-source.js";
import { packageSelectionFor, type BundleDescriptor } from "../src/package-model.js";
import { BUILT_IN_SOURCE, projectSourceOf } from "../src/sources.js";
import { buildTree, describeRow, leavesOf, looseLeavesOf, sourceLabel, type BundleEntry } from "../src/tui/catalog-tree.js";
import { flattenVisible, toggleNode, type Expanded } from "../src/tui/tree.js";

const gitSource = (url: string) => ({ id: sourceIdForUrl(url), kind: "git" as const, url });

test("Catalog labels show repository names and GitHub directory scope", () => {
  assert.equal(sourceLabel(gitSource("https://github.com/mattpocock/skills")), "mattpocock/skills");
  assert.equal(sourceLabel(gitSource("https://github.com/example/skills.git")), "example/skills");
  assert.equal(sourceLabel(gitSource("https://github.com/cursor/plugins/tree/main/pstack")), "cursor/plugins · pstack @ main");
  assert.equal(sourceLabel(gitSource("https://gitlab.com/team/skills.git")), "gitlab.com/team/skills");
  assert.equal(sourceLabel(gitSource("ssh://git@example.com/team/skills.git")), "example.com/team/skills");
  assert.equal(sourceLabel(BUILT_IN_SOURCE), BUILT_IN_SOURCE.id);
});

test("Catalog repository labels keep stable tree and Skill identities", () => {
  const source = gitSource("https://github.com/cursor/plugins/tree/main/pstack");
  const skill = { sourceId: source.id, path: "pstack/skills/example", name: "Example", description: "Example skill" };
  const [root] = buildTree([skill], [source]);
  assert.equal(root.id, `source:${source.id}`);
  assert.equal(describeRow({ node: root, depth: 0, expanded: false, expandable: true, parentId: undefined }), "▸ cursor/plugins · pstack @ main (1)");
  assert.equal(root.children?.[0].id, `skills:${source.id}`);
  assert.equal(root.children?.[0].children?.[0].id, `skill:${source.id}:${skill.path}`);
  const [unknown] = buildTree([skill]);
  assert.equal(describeRow({ node: unknown, depth: 0, expanded: false, expandable: true, parentId: undefined }), `▸ ${source.id} (1)`);
});

test("a Catalog Skill carries its owner only when the Package is active", () => {
  const source = gitSource("https://github.com/mattpocock/skills");
  const skill = { sourceId: source.id, path: "skills/engineering/tdd", name: "tdd", description: "TDD" };
  const descriptor: BundleDescriptor = {
    host: "claude",
    coordinates: { host: "claude", marketplaceRoot: "", pluginName: "mattpocock-skills" },
    name: "mattpocock-skills",
    components: [{ kind: "skills", ownership: "skill-category", effect: "instruction", paths: ["skills"], skillNames: ["tdd"] }],
    warnings: [],
    installable: true,
    manifestDigest: "a".repeat(64),
  };
  const entry: BundleEntry = { sourceId: source.id, selection: packageSelectionFor(descriptor, projectSourceOf(source)), descriptor };

  const unselected = buildTree([skill], [source], [entry], []);
  const unselectedSkill = unselected[0]?.children?.find((node) => node.id.startsWith("skills:"))?.children?.find((node) => node.data.kind === "skill");
  assert.equal(unselectedSkill?.data.kind === "skill" ? unselectedSkill.data.ownedBy : undefined, undefined);

  const otherSource = gitSource("https://github.com/other/skills");
  const otherSkill = { ...skill, sourceId: otherSource.id };
  const mixed = buildTree([skill, otherSkill], [source, otherSource], [entry], [descriptor]);
  const unrelated = mixed.find((node) => node.id === `source:${otherSource.id}`)?.children?.find((node) => node.id.startsWith("skills:"))?.children?.find((node) => node.data.kind === "skill");
  assert.equal(unrelated?.data.kind === "skill" ? unrelated.data.ownedBy : undefined, undefined);

  const active = buildTree([skill], [source], [entry], [descriptor]);
  const activeSkill = active[0]?.children?.find((node) => node.id.startsWith("skills:"))?.children?.find((node) => node.data.kind === "skill");
  assert.equal(activeSkill?.data.kind === "skill" ? activeSkill.data.ownedBy?.name : undefined, "mattpocock-skills");
});

test("Catalog bundle ids stay unique when two descriptors share coordinates, and the row count survives expand and collapse", () => {
  const source = gitSource("https://github.com/pbakaus/impeccable");
  const descriptor = (): BundleDescriptor => ({
    host: "claude",
    coordinates: { host: "claude", marketplaceRoot: "", pluginName: "impeccable" },
    name: "impeccable",
    components: [],
    warnings: [],
    installable: true,
    manifestDigest: "a".repeat(64),
  });
  const entries: BundleEntry[] = [descriptor(), descriptor()].map((d) => ({
    sourceId: source.id,
    selection: packageSelectionFor(d, projectSourceOf(source)),
    descriptor: d,
  }));
  const tree = buildTree([], [source], entries, []);
  const ids = new Set<string>();
  const visit = (nodes: readonly (typeof tree)[number][]): number => nodes.reduce((count, node) => {
    assert.ok(!ids.has(node.id), `duplicate node id ${node.id}`);
    ids.add(node.id);
    return count + 1 + visit(node.children ?? []);
  }, 0);
  visit(tree);
  const bundleRows = (expanded: Expanded) => flattenVisible(tree, expanded).filter((row) => row.node.data.kind === "bundle").length;
  const open = new Set([`source:${source.id}`, `packages:${source.id}`]);
  const counts: number[] = [];
  let expanded: Expanded = open;
  for (let round = 0; round < 4; round += 1) {
    const group = flattenVisible(tree, expanded).find((row) => row.node.id === `packages:${source.id}`)!;
    expanded = toggleNode(expanded, group);
    counts.push(bundleRows(expanded));
  }
  assert.deepEqual(counts, [0, 1, 0, 1]);
});

test("same-named Skills of a Source group into one expandable row whose children are the variants", () => {
  const source = gitSource("https://github.com/example/skills");
  const mk = (path: string, name = "impeccable") => ({ sourceId: source.id, path, name, description: "d" });
  const skills = [mk("a/impeccable"), mk("b/impeccable"), mk("c/solo", "solo")];
  const tree = buildTree(skills, [source]);
  const sourceId = `source:${source.id}`;
  const skillsGroup = `skills:${source.id}`;
  const group = `variants:${source.id}:impeccable`;
  assert.deepEqual(flattenVisible(tree, new Set([sourceId])).slice(1).map(describeRow), ["▸ Skills (3)"]);
  const collapsed = flattenVisible(tree, new Set([sourceId, skillsGroup])).slice(2).map(describeRow);
  assert.deepEqual(collapsed, ["▸ impeccable (2 variants)", "solo  d"]);
  const open = flattenVisible(tree, new Set([sourceId, skillsGroup, group])).slice(2).map(describeRow);
  assert.deepEqual(open, ["▾ impeccable (2 variants)", "impeccable  d  (a/impeccable)", "impeccable  d  (b/impeccable)", "solo  d"]);
  assert.deepEqual(leavesOf(tree).map((skill) => skill.path), ["a/impeccable", "b/impeccable", "c/solo"]);
  assert.deepEqual(looseLeavesOf(tree).map((skill) => skill.path), ["a/impeccable", "b/impeccable", "c/solo"]);
  const ids = flattenVisible(tree, new Set([sourceId, skillsGroup, group])).map((row) => row.node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((tree[0]!.data as { count: number }).count, 3);
  const single = flattenVisible(buildTree([mk("a/impeccable")], [source]), new Set([sourceId, skillsGroup])).slice(2).map(describeRow);
  assert.deepEqual(single, ["impeccable  d"]);
});
