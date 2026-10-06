import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createAppOperations } from "../src/app-flow.js";
import { runCli } from "../src/cli.js";
import { sourceIdForUrl } from "../src/git-source.js";
import { formatPackageSelection } from "../src/package-cli.js";
import type { PackageOperations } from "../src/package-flow.js";
import type { BundleDescriptor, InstalledPackage, PackageLifecyclePlan, PackageSelection, PackageUpdateCheck } from "../src/package-model.js";
import type { SourceOperations } from "../src/sources.js";

const SOURCE = Object.freeze({ kind: "external" as const, url: "https://github.com/example/packages" });
const VERSION = Object.freeze({ policy: "latest" as const });
const PI: PackageSelection = Object.freeze({ host: "pi", root: "", source: SOURCE, version: VERSION });
const CLAUDE: PackageSelection = Object.freeze({ host: "claude", marketplaceRoot: "", pluginName: "demo", source: SOURCE, version: VERSION });
const UNKNOWN: PackageSelection = Object.freeze({ host: "pi", root: "tools", source: SOURCE, version: VERSION });

function descriptor(selection: PackageSelection): BundleDescriptor {
  return Object.freeze({
    host: selection.host,
    coordinates: selection.host === "pi"
      ? Object.freeze({ host: "pi" as const, root: selection.root })
      : Object.freeze({ host: "claude" as const, marketplaceRoot: selection.marketplaceRoot, pluginName: selection.pluginName }),
    name: selection.host === "pi" ? "pi-demo" : selection.pluginName,
    components: Object.freeze([]),
    warnings: Object.freeze([]),
    installable: true,
    manifestDigest: "c".repeat(64),
  });
}

function record(selection: PackageSelection): InstalledPackage {
  return Object.freeze({ selection, installId: formatPackageSelection(selection), verifiedAt: "2026-01-01T00:00:00.000Z" });
}

function plan(selection: PackageSelection): PackageLifecyclePlan {
  return Object.freeze({
    selection,
    action: "update",
    descriptor: descriptor(selection),
    commands: Object.freeze([Object.freeze({ purpose: "apply" as const, executable: selection.host, resolvedPath: `/usr/local/bin/${selection.host}`, args: Object.freeze(["update", formatPackageSelection(selection)]), summary: `${selection.host} update` })]),
    affects: Object.freeze([selection.host === "pi" ? Object.freeze({ host: "pi" as const, root: selection.root }) : Object.freeze({ host: "claude" as const, marketplaceRoot: selection.marketplaceRoot, pluginName: selection.pluginName })]),
    warnings: Object.freeze([]),
    cwd: "/home/test",
    environment: "linux",
    origin: Object.freeze({ manifestDigest: "c".repeat(64), installId: formatPackageSelection(selection) }),
  });
}

function updateCheck(selection: PackageSelection, status: PackageUpdateCheck["status"], reason?: string): PackageUpdateCheck {
  return Object.freeze({
    installed: record(selection),
    status,
    available: status === "unknown" ? undefined : Object.freeze({ kind: "git-commit" as const, commit: "d".repeat(40) }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function fakeSourceOperations(): SourceOperations {
  return {
    addGitSource: async () => { throw new Error("unexpected source add"); },
    listSources: async () => Object.freeze([]),
    refreshSource: async () => { throw new Error("unexpected source refresh"); },
    selectSources: async () => Object.freeze([]),
    listUserGlobalInstallations: async () => Object.freeze([]),
  };
}

interface Fixture {
  readonly packages: PackageOperations;
  readonly planned: readonly string[];
  readonly executed: readonly string[];
  readonly checks: readonly (readonly PackageSelection[] | undefined)[];
}

function fakePackageOperations(options: {
  readonly approved?: boolean;
  readonly failClaude?: boolean;
  readonly checkFails?: boolean;
  readonly statuses?: readonly PackageUpdateCheck[];
} = {}): Fixture {
  const records = Object.freeze([record(PI), record(CLAUDE), record(UNKNOWN)]);
  const checks = options.statuses ?? Object.freeze([
    updateCheck(PI, "update available"),
    updateCheck(CLAUDE, "update available"),
    updateCheck(UNKNOWN, "unknown", "host state unreadable"),
  ]);
  const planned: string[] = [];
  const executed: string[] = [];
  const requestedChecks: (readonly PackageSelection[] | undefined)[] = [];
  const packages: PackageOperations = {
    discover: async () => Object.freeze([]),
    list: async () => records,
    activeBundles: async () => Object.freeze([]),
    inspect: async () => { throw new Error("unexpected package inspect"); },
    approvalStatus: async () => options.approved === false ? "needs approval" as const : "approved" as const,
    approve: async () => undefined,
    planLifecycle: async (selection) => {
      planned.push(formatPackageSelection(selection));
      return plan(selection);
    },
    executeLifecycle: async (packagePlan) => {
      executed.push(formatPackageSelection(packagePlan.selection));
      if (options.failClaude && packagePlan.selection.host === "claude") {
        return Object.freeze({ status: "failed" as const, reason: "host update failed" });
      }
      return Object.freeze({
        status: "updated" as const,
        previous: Object.freeze({ kind: "installed" as const, commit: "a".repeat(40) }),
        verified: Object.freeze({ kind: "installed" as const, commit: "d".repeat(40) }),
      });
    },
    forget: async () => undefined,
    checkUpdates: async (selections) => {
      requestedChecks.push(selections);
      if (options.checkFails) throw new Error("package state unreadable");
      if (selections === undefined) return checks;
      return Object.freeze(checks.filter((check) => selections.some((selection) => formatPackageSelection(selection) === formatPackageSelection(check.installed.selection))));
    },
  };
  return { packages, planned, executed, checks: requestedChecks };
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "package-updates-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runUpdateCli(home: string | undefined, fixture: Fixture, argv: readonly string[]): Promise<{ readonly code: number; readonly lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(argv, {
    ...(home === undefined ? {} : { homeDirectory: home }),
    operations: fakeSourceOperations(),
    packageOperations: fixture.packages,
    ...(home === undefined ? {} : { appOperations: createAppOperations({ recipesDirectory: path.join(home, "apps") }) }),
    stdout: line => lines.push(line),
    stderr: line => lines.push(line),
  });
  return { code, lines };
}

test("update check lists Package rows with the shared unknown, current and update-available statuses", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations({
      statuses: Object.freeze([updateCheck(PI, "update available"), updateCheck(CLAUDE, "current"), updateCheck(UNKNOWN, "unknown", "host state unreadable")]),
    });
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "check", "--scope", "user-global"]);
    assert.equal(code, 0, lines.join("\n"));
    const text = lines.join("\n");
    assert.match(text, new RegExp(`Package ${escape(formatPackageSelection(PI))}: update available; available commit d{40}`, "u"));
    assert.match(text, new RegExp(`Package ${escape(formatPackageSelection(CLAUDE))}: current; available commit d{40}`, "u"));
    assert.match(text, new RegExp(`Package ${escape(formatPackageSelection(UNKNOWN))}: unknown; available unknown; host state unreadable`, "u"));
  });
});

test("update check reads every recorded Package when no filter is given", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    assert.equal((await runUpdateCli(home, fixture, ["update", "check", "--scope", "user-global"])).code, 0);
    assert.deepEqual(fixture.checks, [undefined]);
  });
});

test("update check can filter to one Package", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "check", "--scope", "user-global", "--package", formatPackageSelection(CLAUDE)]);
    assert.equal(code, 0, lines.join("\n"));
    assert.ok(lines.some(line => line.includes(formatPackageSelection(CLAUDE))));
    assert.ok(!lines.some(line => line.includes(formatPackageSelection(PI))));
    assert.deepEqual(fixture.checks.map(selections => selections?.map(formatPackageSelection)), [[formatPackageSelection(CLAUDE)]]);
  });
});

test("update check refuses an unknown Package selection with one usage error", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "check", "--scope", "user-global", "--package", "https://github.com/example/packages::pi:nope"]);
    assert.equal(code, 1);
    assert.deepEqual(lines.filter(line => line.startsWith("Error")), ['Error: Unknown Package selection "https://github.com/example/packages::pi:nope"']);
    assert.deepEqual(fixture.checks, []);
  });
});

test("update apply --all includes Packages, isolates one failure, and never offers an unknown Package", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations({ failClaude: true });
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--all", "--yes"]);
    assert.equal(code, 1);
    assert.deepEqual([...fixture.planned].sort(), [formatPackageSelection(CLAUDE), formatPackageSelection(PI)].sort());
    assert.deepEqual([...fixture.executed].sort(), [formatPackageSelection(CLAUDE), formatPackageSelection(PI)].sort());
    assert.ok(!fixture.planned.includes(formatPackageSelection(UNKNOWN)));
    assert.ok(lines.some(line => line.includes("Package") && line.includes("failed: host update failed")));
    assert.ok(lines.some(line => line.includes("Update summary: 1 updated, 1 failed")));
  });
});

test("update apply --package updates exactly the named Package", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--package", formatPackageSelection(PI), "--yes"]);
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(fixture.executed, [formatPackageSelection(PI)]);
    assert.ok(lines.some(line => line.includes("Update summary: 1 updated, 0 failed")));
  });
});

test("update apply --package accepts the Source-id spelling that package discover prints", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--package", `${sourceIdForUrl(SOURCE.url)}::pi:.`, "--yes"]);
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(fixture.executed, [formatPackageSelection(PI)]);
  });
});

test("update apply refuses an unknown version Package instead of offering it", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--package", formatPackageSelection(UNKNOWN), "--yes"]);
    assert.equal(code, 1);
    assert.ok(lines.some(line => line.includes("has unknown version status and is not updateable")));
    assert.deepEqual(fixture.executed, []);
  });
});

test("update apply refuses a current Package instead of running the host command", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations({ statuses: Object.freeze([updateCheck(PI, "current")]) });
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--package", formatPackageSelection(PI), "--yes"]);
    assert.equal(code, 1);
    assert.ok(lines.some(line => line.includes("has no available update")));
    assert.deepEqual(fixture.executed, []);
  });
});

test("update apply refuses an unapproved Package without executing it", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations({ approved: false });
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--package", formatPackageSelection(PI), "--yes"]);
    assert.equal(code, 1);
    assert.deepEqual(fixture.executed, []);
    assert.ok(lines.some(line => line.includes("needs approval for update")));
  });
});

test("one failing Package check does not hide the other checks or the Skill batch", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations({ checkFails: true });
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "check", "--scope", "user-global"]);
    assert.equal(code, 1);
    assert.ok(lines.some(line => line.includes("Error (Packages): package state unreadable")));
    assert.ok(lines.some(line => line.includes("Update check (scope: user-global)")));
  });
});

test("a failed Package batch check is reported as a failure without stopping Skills", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations({ checkFails: true });
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--all", "--yes"]);
    assert.equal(code, 1);
    assert.ok(lines.some(line => line.includes("Error (Packages): package state unreadable")));
    assert.ok(lines.some(line => line.includes("Update summary: 0 updated, 1 failed")));
  });
});

test("project scope never selects a Package", async () => {
  const fixture = fakePackageOperations();
  const { code, lines } = await runUpdateCli(undefined, fixture, ["update", "apply", "--scope", "project", "--package", formatPackageSelection(PI), "--yes"]);
  assert.equal(code, 1);
  assert.ok(lines.some(line => line.includes("Packages are user-global only")));
  assert.deepEqual(fixture.checks, []);
  assert.deepEqual(fixture.executed, []);
});

test("project scope --all skips Packages without reading their state", async () => {
  const fixture = fakePackageOperations();
  const { code, lines } = await runUpdateCli(undefined, fixture, ["update", "apply", "--scope", "project", "--all", "--yes"]);
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(fixture.checks, []);
  assert.ok(!lines.some(line => line.startsWith("Package ")));
});

test("update apply rejects --package together with --all", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--all", "--package", formatPackageSelection(PI), "--yes"]);
    assert.equal(code, 1);
    assert.ok(lines.some(line => line.includes("exactly one selection mode")));
    assert.deepEqual(fixture.checks, []);
  });
});

test("update apply rejects a duplicate Package selection", async () => {
  await withHome(async (home) => {
    const fixture = fakePackageOperations();
    const { code, lines } = await runUpdateCli(home, fixture, ["update", "apply", "--scope", "user-global", "--package", formatPackageSelection(PI), "--package", formatPackageSelection(PI), "--yes"]);
    assert.equal(code, 1);
    assert.ok(lines.some(line => line.includes("Duplicate Package selection")));
  });
});

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
