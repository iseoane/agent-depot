import assert from "node:assert/strict";
import { test } from "node:test";

import { PACKAGE_USAGE, formatPackageSelection, runPackageCommand } from "../src/package-cli.js";
import type { PackageOperations } from "../src/package-flow.js";
import type {
  BundleDescriptor,
  InstalledPackage,
  PackageAction,
  PackageInspection,
  PackageLifecyclePlan,
  PackageLifecycleResult,
  PackageSelection,
} from "../src/package-model.js";
import type { Source, SourceOperations } from "../src/sources.js";

const SOURCE = Object.freeze({ id: "git:github.com/example/demo", kind: "git" as const, url: "https://github.com/example/demo" });
const PROJECT_SOURCE = Object.freeze({ kind: "external" as const, url: SOURCE.url });
const VERSION = Object.freeze({ policy: "latest" as const });
const PI: PackageSelection = Object.freeze({ host: "pi", root: "", source: PROJECT_SOURCE, version: VERSION });
const CLAUDE: PackageSelection = Object.freeze({ host: "claude", marketplaceRoot: "", pluginName: "demo", source: PROJECT_SOURCE, version: VERSION });
const PI_TOKEN = "git:github.com/example/demo::pi:.";
const CLAUDE_TOKEN = "git:github.com/example/demo::claude:.#demo";

const PI_DESCRIPTOR: BundleDescriptor = Object.freeze({
  host: "pi",
  coordinates: Object.freeze({ host: "pi" as const, root: "" }),
  name: "demo",
  version: Object.freeze({ kind: "manifest-version" as const, version: "1.0.0", declaredBy: "bundle" as const }),
  components: Object.freeze([
    Object.freeze({ kind: "skills" as const, ownership: "skill-category" as const, effect: "instruction" as const, paths: Object.freeze(["skills"]), skillNames: Object.freeze(["demo"]) }),
    Object.freeze({ kind: "extensions" as const, ownership: "host-only" as const, effect: "executable" as const, paths: Object.freeze(["extensions/demo.ts"]) }),
    Object.freeze({ kind: "prompts" as const, ownership: "host-only" as const, effect: "data" as const, paths: Object.freeze(["prompts/demo.md"]) }),
  ]),
  warnings: Object.freeze([]),
  manifestDigest: "a".repeat(64),
});

const CLAUDE_DESCRIPTOR: BundleDescriptor = Object.freeze({
  ...PI_DESCRIPTOR,
  host: "claude",
  coordinates: Object.freeze({ host: "claude" as const, marketplaceRoot: "", pluginName: "demo" }),
});

function record(selection: PackageSelection): InstalledPackage {
  return Object.freeze({ selection, installId: `git:github.com/example/demo@${selection.host}`, verifiedAt: "2026-01-01T00:00:00.000Z" });
}

function plan(selection: PackageSelection, action: PackageAction): PackageLifecyclePlan {
  const descriptor = selection.host === "pi" ? PI_DESCRIPTOR : CLAUDE_DESCRIPTOR;
  return Object.freeze({
    selection,
    action,
    descriptor,
    commands: Object.freeze([Object.freeze({
      purpose: action === "uninstall" ? "remove" as const : "apply" as const,
      executable: selection.host,
      resolvedPath: `/usr/local/bin/${selection.host}`,
      args: Object.freeze([action === "uninstall" ? "remove" : action, "git:github.com/example/demo"]),
      summary: `${selection.host} ${action}`,
    })]),
    affects: Object.freeze([selection.host === "pi" ? Object.freeze({ host: "pi" as const, root: "" }) : Object.freeze({ host: "claude" as const, marketplaceRoot: "", pluginName: "demo" })]),
    warnings: Object.freeze(["the host reconciles every recorded bundle"]),
    cwd: "/home/test",
    environment: "linux",
    origin: Object.freeze({ manifestDigest: "a".repeat(64), installId: "git:github.com/example/demo", resolvedCommit: "b".repeat(40) }),
  });
}

function fakeSources(overrides: Partial<SourceOperations> = {}): SourceOperations {
  return {
    addGitSource: async () => { throw new Error("unexpected source add"); },
    listSources: async () => Object.freeze([SOURCE as Source]),
    refreshSource: async () => { throw new Error("unexpected source refresh"); },
    selectSources: async () => Object.freeze([]),
    ...overrides,
  };
}

interface Fixture {
  readonly packages: PackageOperations;
  readonly executed: readonly PackageAction[];
  readonly executedConfirmed: readonly boolean[];
  readonly approved: readonly PackageAction[];
  readonly forgotten: readonly PackageSelection[];
  readonly lines: string[];
}

function fixture(options: { readonly approved?: boolean; readonly recorded?: readonly InstalledPackage[] } = {}): Fixture {
  const executed: PackageAction[] = [];
  const executedConfirmed: boolean[] = [];
  const approved: PackageAction[] = [];
  const forgotten: PackageSelection[] = [];
  const lines: string[] = [];
  const approvedStatus = options.approved === false ? "needs approval" as const : "approved" as const;
  const inspection = (selection: PackageSelection): PackageInspection => Object.freeze({
    descriptor: selection.host === "pi" ? PI_DESCRIPTOR : CLAUDE_DESCRIPTOR,
    installed: Object.freeze({ kind: "absent" as const }),
    available: PI_DESCRIPTOR.version,
    approval: approvedStatus,
  });
  const packages: PackageOperations = {
    discover: async (sourceIds) => sourceIds.includes(SOURCE.id)
      ? Object.freeze([PI_DESCRIPTOR, CLAUDE_DESCRIPTOR])
      : Object.freeze([]),
    list: async () => options.recorded ?? Object.freeze([record(PI)]),
    inspect: async (selection) => inspection(selection),
    approvalStatus: async () => approvedStatus,
    approve: async (_selection, action = "install") => { approved.push(action); },
    planLifecycle: async (selection, action) => plan(selection, action),
    executeLifecycle: async (packagePlan, confirmed): Promise<PackageLifecycleResult> => {
      executed.push(packagePlan.action);
      executedConfirmed.push(confirmed);
      switch (packagePlan.action) {
        case "update":
          return Object.freeze({
            status: "updated" as const,
            previous: Object.freeze({ kind: "installed" as const, version: "1.0.0" }),
            verified: Object.freeze({ kind: "installed" as const, version: "2.0.0" }),
          });
        case "uninstall":
          return Object.freeze({ status: "removed" as const });
        default:
          return Object.freeze({ status: "installed" as const, verified: Object.freeze({ kind: "installed" as const, version: "1.0.0" }) });
      }
    },
    forget: async (selection, confirmed) => {
      assert.equal(confirmed, true);
      forgotten.push(selection);
    },
    checkUpdates: async () => Object.freeze([]),
  };
  return { packages, executed, executedConfirmed, approved, forgotten, lines };
}

async function run(f: Fixture, argv: readonly string[], sources = fakeSources()): Promise<number> {
  return await runPackageCommand(argv, f.packages, sources, (line) => f.lines.push(line));
}

const USAGE_ERROR = Object.freeze({ name: "CliUsageError", message: PACKAGE_USAGE });

test("package list prints every recorded selection with its install id and verified evidence", async () => {
  const f = fixture({ recorded: Object.freeze([record(PI), Object.freeze({ ...record(CLAUDE), verified: Object.freeze({ kind: "manifest-version" as const, version: "2.0.0", declaredBy: "bundle" as const }) })]) });
  assert.equal(await run(f, ["list"]), 0);
  assert.ok(f.lines.some((line) => line.includes(formatPackageSelection(PI)) && line.includes("verified=unknown")));
  assert.ok(f.lines.some((line) => line.includes(formatPackageSelection(CLAUDE)) && line.includes("verified=2.0.0 (bundle)")));
});

test("package list rejects extra arguments instead of guessing", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["list", "--host", "pi"]), { name: "CliUsageError", message: "Usage: agent-depot package list" });
});

test("package discover names host-qualified selections and every component with ownership, effect and risk", async () => {
  const f = fixture();
  assert.equal(await run(f, ["discover", SOURCE.id]), 0);
  const text = f.lines.join("\n");
  assert.match(text, /Package git:github\.com\/example\/demo::pi:\.: demo/u);
  assert.match(text, /Package git:github\.com\/example\/demo::claude:\.#demo: demo/u);
  assert.match(text, /skills: ownership=skill-category; effect=instruction; risk=medium: the host loads it into agent context; paths=skills; skills=demo/u);
  assert.match(text, /extensions: ownership=host-only; effect=executable; risk=high: the host runs it/u);
  assert.match(text, /prompts: ownership=host-only; effect=data; risk=low: data only/u);
});

test("package discover requires exactly one Source id", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["discover"]), USAGE_ERROR);
  await assert.rejects(run(f, ["discover", SOURCE.id, SOURCE.id]), USAGE_ERROR);
});

test("package inspect reports the host evidence, the approval state and the descriptor", async () => {
  const f = fixture();
  assert.equal(await run(f, ["inspect", PI_TOKEN, "--host", "pi"]), 0);
  const text = f.lines.join("\n");
  assert.match(text, /Package inspect: https:\/\/github\.com\/example\/demo::pi:\./u);
  assert.match(text, /installed: absent/u);
  assert.match(text, /available: 1\.0\.0 \(bundle\)/u);
  assert.match(text, /approval: approved/u);
  assert.match(text, /descriptor: demo; host=pi/u);
  assert.match(text, /components \(3\)/u);
  assert.deepEqual(f.executed, []);
});

test("package install previews the exact argv, executable, blast radius, cwd and environment, then refuses without --yes", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["install", PI_TOKEN, "--host", "pi"]), /not confirmed/u);
  const text = f.lines.join("\n");
  assert.match(text, /Package install preview: https:\/\/github\.com\/example\/demo::pi:\./u);
  assert.match(text, /approval: approved/u);
  assert.match(text, /origin: installId=git:github\.com\/example\/demo; manifest=a{64}; commit=b{40}/u);
  assert.match(text, /host commands \(1\)/u);
  assert.match(text, /\[0\] purpose=apply; argv=\["pi","install","git:github\.com\/example\/demo"\]; resolved=\/usr\/local\/bin\/pi; summary=pi install/u);
  assert.match(text, /affects \(1\)/u);
  assert.match(text, /pi \./u);
  assert.match(text, /working directory: \/home\/test/u);
  assert.match(text, /environment: linux/u);
  assert.match(text, /warning: the host reconciles every recorded bundle/u);
  assert.deepEqual(f.executed, []);
});

test("package install never lets --yes bypass the approval receipt", async () => {
  const f = fixture({ approved: false });
  await assert.rejects(run(f, ["install", PI_TOKEN, "--host", "pi", "--yes"]), /needs approval/u);
  assert.ok(f.lines.some((line) => line.includes("approval: needs approval")));
  assert.deepEqual(f.executed, []);
});

test("package approve writes only the action it was asked for", async () => {
  const f = fixture();
  assert.equal(await run(f, ["approve", PI_TOKEN, "--host", "pi", "--action", "update"]), 0);
  assert.deepEqual(f.approved, ["update"]);
  assert.equal(await run(f, ["approve", PI_TOKEN, "--host", "pi"]), 0);
  assert.deepEqual(f.approved, ["update", "install"]);
  assert.ok(f.lines.some((line) => line.includes("Approved Package update")));
});

test("package approve refuses select and forget as approval actions", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["approve", PI_TOKEN, "--host", "pi", "--action", "forget"]), /approval action must be install, update, or uninstall/u);
  await assert.rejects(run(f, ["approve", PI_TOKEN, "--host", "pi", "--action", "select"]), /approval action must be install, update, or uninstall/u);
  assert.deepEqual(f.approved, []);
});

test("package update and uninstall preview and execute only when confirmed", async () => {
  const f = fixture();
  assert.equal(await run(f, ["update", PI_TOKEN, "--host", "pi", "--yes"]), 0);
  assert.match(f.lines.join("\n"), /Package https:\/\/github\.com\/example\/demo::pi:\.: updated \(installed 1\.0\.0 -> installed 2\.0\.0\)/u);
  assert.equal(await run(f, ["uninstall", PI_TOKEN, "--host", "pi", "--yes"]), 0);
  assert.match(f.lines.join("\n"), /Package https:\/\/github\.com\/example\/demo::pi:\.: removed/u);
  assert.deepEqual(f.executed, ["update", "uninstall"]);
  assert.deepEqual(f.executedConfirmed, [true, true]);
});

test("package uninstall without --yes previews the removal argv and runs nothing", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["uninstall", PI_TOKEN, "--host", "pi"]), /not confirmed/u);
  assert.match(f.lines.join("\n"), /argv=\["pi","remove","git:github\.com\/example\/demo"\]/u);
  assert.deepEqual(f.executed, []);
});

test("package forget previews that no host command runs, requires --yes, and never runs a lifecycle", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["forget", PI_TOKEN, "--host", "pi"]), /not confirmed/u);
  assert.deepEqual(f.forgotten, []);
  assert.match(f.lines.join("\n"), /Host commands: none/u);
  assert.equal(await run(f, ["forget", PI_TOKEN, "--host", "pi", "--yes"]), 0);
  assert.equal(f.forgotten.length, 1);
  assert.equal(formatPackageSelection(f.forgotten[0]!), formatPackageSelection(PI));
  assert.deepEqual(f.executed, []);
});

test("package forget resolves a recorded selection without re-reading the Sources", async () => {
  const f = fixture();
  const sources = fakeSources({ listSources: async () => { throw new Error("forget must use the record"); } });
  assert.equal(await run(f, ["forget", formatPackageSelection(PI), "--yes"], sources), 0);
  assert.equal(f.forgotten.length, 1);
});

test("package selections accept a host-qualified token without --host", async () => {
  const f = fixture();
  assert.equal(await run(f, ["inspect", PI_TOKEN]), 0);
  assert.equal(await run(f, ["inspect", CLAUDE_TOKEN]), 0);
  assert.match(f.lines.join("\n"), /descriptor: demo; host=claude/u);
});

test("package selections refuse a Host that contradicts the token", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["inspect", CLAUDE_TOKEN, "--host", "pi"]), /conflicts with --host/u);
  await assert.rejects(run(f, ["inspect", PI_TOKEN, "--host", "pi", "--host", "claude"]), /conflicts with --host/u);
});

test("package selections need a Host when the token carries none", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["inspect", `${SOURCE.id}::.`]), /needs --host pi or --host claude/u);
});

test("package command rejects an unknown Host before planning", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["inspect", PI_TOKEN, "--host", "codex"]), /Unsupported Package Host "codex"; expected pi or claude/u);
  assert.deepEqual(f.executed, []);
});

test("package command rejects --yes where the grammar has no execution to confirm", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["inspect", PI_TOKEN, "--host", "pi", "--yes"]), USAGE_ERROR);
  await assert.rejects(run(f, ["approve", PI_TOKEN, "--host", "pi", "--yes"]), USAGE_ERROR);
  assert.deepEqual(f.approved, []);
});

test("package command rejects --action outside approve", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["install", PI_TOKEN, "--host", "pi", "--action", "install"]), USAGE_ERROR);
  assert.deepEqual(f.executed, []);
});

test("package selections refuse a path that is not Source-relative or not canonical", async () => {
  const f = fixture();
  for (const token of [`${SOURCE.id}::/etc`, `${SOURCE.id}::../escape`, `${SOURCE.id}::a/./b`, `${SOURCE.id}::a/`, `${SOURCE.id}::`]) {
    await assert.rejects(run(f, ["inspect", token, "--host", "pi"]), /not a (canonical )?Source-relative directory|Package selection must be/u, token);
  }
  await assert.rejects(run(f, ["inspect", `${SOURCE.id}::pi:a#b`]), /plugin name/u);
  await assert.rejects(run(f, ["inspect", `${SOURCE.id}::claude:a#bad/name`]), /plugin name/u);
});

test("package selections refuse a Source that is not registered or is ambiguous", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["inspect", "missing::.", "--host", "pi"]), /Source is not registered: missing/u);
  await assert.rejects(run(f, ["inspect", "https://github.com/example/demo::.", "--host", "pi"], fakeSources({
    listSources: async () => Object.freeze([SOURCE as Source, { ...SOURCE, id: "git:other" } as Source]),
  })), /matches more than one Source/u);
});

test("package selections refuse a bundle the Source does not provide, and name an ambiguous one", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["inspect", `${SOURCE.id}::pi:missing`, "--host", "pi"]), /No pi Package at "missing"/u);
  const duplicate = fixture();
  const ambiguous: PackageOperations = {
    ...duplicate.packages,
    discover: async () => Object.freeze([PI_DESCRIPTOR, { ...PI_DESCRIPTOR, name: "second" }]),
  };
  await assert.rejects(
    runPackageCommand(["inspect", `${SOURCE.id}::.`, "--host", "pi"], ambiguous, fakeSources(), () => undefined),
    /ambiguous for Host pi/u,
  );
});

test("package command rejects an unknown subcommand with the package usage", async () => {
  const f = fixture();
  await assert.rejects(run(f, ["bogus"]), USAGE_ERROR);
});

test("package lifecycle reports a non-zero code for a failed host command", async () => {
  const f = fixture();
  const failing: PackageOperations = {
    ...f.packages,
    executeLifecycle: async () => Object.freeze({ status: "failed" as const, reason: "pi exited 1", output: "boom" }),
  };
  assert.equal(await runPackageCommand(["install", PI_TOKEN, "--host", "pi", "--yes"], failing, fakeSources(), (line) => f.lines.push(line)), 1);
  assert.match(f.lines.join("\n"), /failed: pi exited 1; boom/u);
});
