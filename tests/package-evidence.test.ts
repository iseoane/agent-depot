import assert from "node:assert/strict";
import { test } from "node:test";

import { describePackageResult } from "../src/package-cli.js";
import { classifyUpdate } from "../src/package-host-plans.js";
import type { InstalledPackage } from "../src/package-model.js";
import { installedEvidenceLabel, packageRow } from "../src/tui/package-rows.js";

const record: InstalledPackage = {
  selection: { host: "claude", marketplaceRoot: "", pluginName: "demo",
    source: { kind: "external", url: "https://github.com/example/demo" }, version: { policy: "latest" } },
  installId: "demo@market", verifiedAt: "2026-01-01T00:00:00.000Z",
  verified: { kind: "manifest-version", version: "0.9.0", declaredBy: "bundle" },
};
const previous = { kind: "installed", version: "1.6.1", commit: "a".repeat(40) } as const;
const verified = { ...previous, commit: "b".repeat(40) };

test("host-aware comparison preserves unknown, dirty and unversioned evidence safety", () => {
  const available = { kind: "manifest-version", version: "1.6.1", declaredBy: "bundle" } as const;
  assert.equal(classifyUpdate(previous, available, verified.commit, true, "pi"), "update available");
  assert.equal(classifyUpdate(previous, available, verified.commit, undefined, "pi"), "unknown");
  assert.equal(classifyUpdate(previous, available, verified.commit, true, "claude"), "current");
  assert.equal(classifyUpdate({ ...previous, version: "v1.6.1" }, available, verified.commit, true, "claude"), "update available",
    "Claude compares literal cache keys, not normalized semver");
  assert.equal(classifyUpdate({ kind: "installed", commit: previous.commit }, available, previous.commit, true, "claude"), "unknown");
  for (const host of ["pi", "claude"] as const) {
    assert.equal(classifyUpdate({ ...previous, reason: "local changes" }, available, verified.commit, true, host), "unknown");
    assert.equal(classifyUpdate({ kind: "unknown", reason: "unreadable" }, available, verified.commit, true, host), "unknown");
    assert.equal(classifyUpdate({ kind: "absent" }, available, verified.commit, true, host), "unknown");
    assert.equal(classifyUpdate(previous, undefined, verified.commit, true, host), "unknown");
    assert.equal(classifyUpdate(previous, { kind: "git-commit", commit: verified.commit }, undefined, true, host), "update available");
    assert.equal(classifyUpdate(previous, { kind: "git-commit", commit: verified.commit }, undefined, false, host), "unknown");
  }
});

test("Package presentation retains version and commit on both sides of a same-version update", () => {
  assert.equal(installedEvidenceLabel(previous), "installed 1.6.1 (aaaaaaa)");
  const result = { status: "updated", previous, verified } as const;
  assert.match(describePackageResult(result), /1\.6\.1.*aaaaaaa.*->.*1\.6\.1.*bbbbbbb/);
  const row = packageRow(record, {
    installed: previous, available: { kind: "manifest-version", version: "1.6.1", declaredBy: "bundle" },
    availableCommit: verified.commit, installedCommitIsAncestor: true, approval: "approved",
  });
  assert.equal(row.status.kind, "current", "Installations uses the selected Host even without a descriptor");
  assert.equal(row.installedVersion, "1.6.1 (aaaaaaa)");
  assert.equal(row.available, "1.6.1 (bbbbbbb)");
});
