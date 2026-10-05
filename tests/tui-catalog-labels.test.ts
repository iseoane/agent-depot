import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceIdForUrl } from "../src/git-source.js";
import { BUILT_IN_SOURCE } from "../src/sources.js";
import { buildTree, describeRow, sourceLabel } from "../src/tui/catalog-tree.js";

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
  assert.equal(root.children?.[0].id, `skill:${source.id}:${skill.path}`);
  const [unknown] = buildTree([skill]);
  assert.equal(describeRow({ node: unknown, depth: 0, expanded: false, expandable: true, parentId: undefined }), `▸ ${source.id} (1)`);
});
