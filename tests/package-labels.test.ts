import assert from "node:assert/strict";
import { test } from "node:test";

import type { BundleDescriptor, InstalledPackage, PackageLifecyclePlan, PackageSelection } from "../src/package-model.js";
import { packagePlanLines, packageRow } from "../src/tui/package-rows.js";

const source = { kind: "external", url: "https://example.test/demo.git" } as const;
const selection: PackageSelection = { host: "claude", marketplaceRoot: "", pluginName: "demo", source, version: { policy: "latest" } };
const record: InstalledPackage = { selection, installId: "claude:demo", verifiedAt: "2026-01-01T00:00:00.000Z" };
const descriptor: BundleDescriptor = {
  host: "claude",
  coordinates: { host: "claude", marketplaceRoot: "", pluginName: "demo" },
  name: "demo",
  components: [],
  warnings: [],
  installable: true,
  manifestDigest: "c".repeat(64),
};
const plan: PackageLifecyclePlan = {
  selection,
  action: "update",
  descriptor,
  commands: [],
  affects: [descriptor.coordinates],
  warnings: [],
  cwd: "/home/user",
  environment: "linux",
  origin: { manifestDigest: descriptor.manifestDigest, installId: record.installId },
};

test("a root-level Package is named with its Source, never as name@.", () => {
  const text = packagePlanLines(plan, "approved").join("\n");
  assert.match(text, /Coordinates: https:\/\/example\.test\/demo\.git::claude#demo/);
  assert.match(text, /Blast radius: https:\/\/example\.test\/demo\.git::claude#demo/);
  assert.doesNotMatch(text, /demo@\.|:\.#/);
});

test("the row name falls back to the Source-qualified label while the bundle does not resolve", () => {
  const row = packageRow(record, { installed: { kind: "not installed" }, approval: "approved" } as never);
  assert.equal(row.name, "https://example.test/demo.git::claude#demo");
});

test("a commit-only version is labelled as a commit in the list row and in the plan", () => {
  const commit = "45e0761".padEnd(40, "0");
  const row = packageRow(record, {
    descriptor: { ...descriptor, version: { kind: "git-commit", commit } },
    installed: { kind: "installed", commit },
    available: { kind: "git-commit", commit },
    approval: "approved",
  } as never);
  assert.equal(row.installedVersion, "commit 45e0761");
  assert.equal(row.available, "commit 45e0761");
  const lines = packagePlanLines({ ...plan, descriptor: { ...descriptor, version: { kind: "git-commit", commit } } }, "approved");
  assert.ok(lines.includes("Available: commit 45e0761"));
});
