import assert from "node:assert/strict";
import { test } from "node:test";

import { groupUpdates, type GroupableUpdate } from "../src/update-groups.js";

type AnyItem = GroupableUpdate & { readonly name: string };

const skill = (name: string, id: string, label = id): AnyItem => ({ kind: "skill", name, source: { id, label } });
const pkg = (name: string, id: string, label = id): AnyItem => ({ kind: "package", name, source: { id, label } });
const app = (name: string): AnyItem => ({ kind: "app", name });
const names = (items: readonly { readonly name: string }[]) => items.map((item) => item.name);

test("groups by Source ordered by label then id, Packages before Skills, Apps apart", () => {
  const groups = groupUpdates<AnyItem>([
    skill("s-b", "b", "beta"),
    app("app1"),
    pkg("p-a", "a2", "alpha"),
    skill("s-a", "a2", "alpha"),
    pkg("p-a1", "a1", "alpha"),
    pkg("p-b", "b", "beta"),
  ]);
  assert.deepEqual(groups.sources.map((group) => group.source.id), ["a1", "a2", "b"]);
  assert.deepEqual(
    groups.sources.map((group) => group.subgroups.map((sub) => [sub.kind, names(sub.items)])),
    [[["packages", ["p-a1"]]], [["packages", ["p-a"]], ["skills", ["s-a"]]], [["packages", ["p-b"]], ["skills", ["s-b"]]]],
  );
  assert.deepEqual(names(groups.apps), ["app1"]);
});

test("leaf order within a subgroup follows the input and empty subgroups are omitted", () => {
  const groups = groupUpdates<AnyItem>([skill("z", "x"), skill("a", "x"), skill("m", "x")]);
  assert.equal(groups.sources.length, 1);
  assert.deepEqual(groups.sources[0]!.subgroups.map((sub) => sub.kind), ["skills"]);
  assert.deepEqual(names(groups.sources[0]!.subgroups[0]!.items), ["z", "a", "m"]);
});

test("orders labels by code unit, not by locale", () => {
  const groups = groupUpdates<AnyItem>([skill("1", "u", "a"), skill("2", "t", "B"), skill("3", "s", "_")]);
  assert.deepEqual(groups.sources.map((group) => group.source.label), ["B", "_", "a"]);
});

test("no updates gives no groups", () => {
  assert.deepEqual(groupUpdates<AnyItem>([]), { sources: [], apps: [] });
});
