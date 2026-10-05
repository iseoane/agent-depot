import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFERRED_COMPONENT_KINDS,
  PACKAGE_HOSTS,
  bundleRoot,
  describeCoordinates,
  selectionKey,
  type PackageCoordinates,
  type PackageSelection,
} from "../src/package-model.js";
import type { ProjectSource } from "../src/project-manifest.js";

const sourceA: ProjectSource = { kind: "external", url: "https://github.com/example/pstack.git" };
const sourceB: ProjectSource = { kind: "external", url: "https://github.com/example/other.git" };

function piSelection(root: string, source: ProjectSource = sourceA): PackageSelection {
  return { host: "pi", root, source, version: { policy: "latest" } };
}

function claudeSelection(marketplaceRoot: string, pluginName: string): PackageSelection {
  return { host: "claude", marketplaceRoot, pluginName, source: sourceA, version: { policy: "latest" } };
}

const assertCoordinate = (coordinate: PackageCoordinates): void => {
  void coordinate;
};

test("PACKAGE_HOSTS is the V1 host set and DEFERRED_COMPONENT_KINDS is the single deferred list", () => {
  assert.deepEqual([...PACKAGE_HOSTS], ["pi", "claude"]);
  assert.deepEqual([...DEFERRED_COMPONENT_KINDS], ["agents", "mcp-servers"]);
});

test("bundleRoot returns the directory where a bundle lives", () => {
  assert.equal(bundleRoot({ host: "pi", root: "packages/p" }), "packages/p");
  assert.equal(bundleRoot({ host: "claude", marketplaceRoot: "market", pluginName: "p" }), "market");
});

test("describeCoordinates renders each host form", () => {
  assert.equal(describeCoordinates({ host: "pi", root: "." }), "pi .");
  assert.equal(describeCoordinates({ host: "pi", root: "plugins/pstack" }), "pi plugins/pstack");
  assert.equal(describeCoordinates({ host: "claude", marketplaceRoot: "", pluginName: "pstack" }), "claude pstack@.");
  assert.equal(describeCoordinates({ host: "claude", marketplaceRoot: "market", pluginName: "pstack" }), "claude pstack@market");
});

test("selectionKey is stable across a bundle rename and version-policy change", () => {
  const base = piSelection(".");
  assert.equal(
    selectionKey(base),
    selectionKey({ ...base, version: { policy: "fixed", version: "1.2.3" } }),
  );
});

test("selectionKey changes when the source or coordinates change", () => {
  const base = piSelection(".");
  assert.notEqual(selectionKey(base), selectionKey(piSelection(".", sourceB)));
  assert.notEqual(selectionKey(base), selectionKey(piSelection("subdir")));
  assert.notEqual(selectionKey(base), selectionKey(claudeSelection("", "pstack")));
});

test("a Claude coordinate cannot be constructed without both marketplace fields", () => {
  // @ts-expect-error a Claude coordinate requires marketplaceRoot and pluginName together
  assertCoordinate({ host: "claude", pluginName: "pstack" });
  // @ts-expect-error a Claude coordinate requires marketplaceRoot and pluginName together
  assertCoordinate({ host: "claude", marketplaceRoot: "" });
});
