import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import type { PackageOperations } from "../src/package-flow.js";
import type { BundleDescriptor, PackageAction, PackageLifecyclePlan, PackageLifecycleResult, PackageSelection } from "../src/package-model.js";
import { parseProjectManifest, ProjectManifestStore } from "../src/project-manifest.js";
import type { SkillCandidate } from "../src/skill-discovery.js";
import type { SourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { fakePackageOperations } from "./fake-package-operations.js";
import { renderExpanded } from "./render-expanded.js";
import { waitForFrame } from "./wait-for-frame.js";

const ENTER = "\r";
const ESC = "\u001B";

const source = { id: "git:1234567890abcdef12345678", kind: "git" as const, url: "https://github.com/iseoane/pstack.git" };

const pi: BundleDescriptor = {
  host: "pi",
  coordinates: { host: "pi", root: "plugins/pstack" },
  name: "pstack",
  version: { kind: "manifest-version", version: "1.2.0", declaredBy: "bundle" },
  components: [
    { kind: "skills", ownership: "skill-category", effect: "instruction", paths: ["plugins/pstack/skills"], skillNames: ["how"] },
    { kind: "extensions", ownership: "host-only", effect: "executable", paths: ["plugins/pstack/extensions/index.ts"] },
  ],
  warnings: [],
  manifestDigest: "a".repeat(64),
};

const skills: readonly SkillCandidate[] = [
  { sourceId: source.id, path: "plugins/loose/loose", name: "loose", description: "A loose skill" },
];

class EmptyManifestStore extends ProjectManifestStore {
  constructor() {
    super("/nonexistent/agent-depot-test/agent-depot.json");
  }

  override async load() {
    return parseProjectManifest({ version: 1, skills: [] });
  }
}

function operationsFor(discoverSkills: SourceOperations["discoverSkills"]): SourceOperations {
  return {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return [source];
    },
    async refreshSource() {
      throw new Error("unused");
    },
    async selectSources() {
      return [];
    },
    async listUserGlobalInstallations() {
      return [];
    },
    discoverSkills,
  };
}

function planOf(selection: PackageSelection, action: PackageAction): PackageLifecyclePlan {
  return {
    selection,
    action,
    descriptor: pi,
    commands: [{
      purpose: "apply",
      executable: "pi",
      resolvedPath: "/usr/bin/pi",
      args: ["install", "github.com/iseoane/pstack"],
      summary: "pi install",
    }],
    affects: [{ host: "pi", root: "plugins/pstack" }],
    warnings: [],
    cwd: "/home/user",
    environment: "linux",
    origin: { manifestDigest: pi.manifestDigest, installId: "pi:github.com/iseoane/pstack", resolvedCommit: "b".repeat(40) },
  };
}

const installed: PackageLifecycleResult = { status: "installed", verified: { kind: "installed", version: "1.2.0" } };

interface Fixture {
  readonly view: ReturnType<typeof render>;
  readonly calls: string[];
  readonly selections: PackageSelection[];
}

interface Options {
  readonly approval?: "approved" | "needs approval";
  readonly execute?: (plan: PackageLifecyclePlan) => PackageLifecycleResult;
  readonly planError?: boolean;
  readonly discoverSkills?: readonly SkillCandidate[];
}

async function fixture(t: { after(callback: () => void | Promise<void>): void }, options: Options = {}): Promise<Fixture> {
  const calls: string[] = [];
  const selections: PackageSelection[] = [];
  const packages: PackageOperations = fakePackageOperations({
    discover: async () => [pi],
    planLifecycle: async (selection, action) => {
      if (options.planError) throw new Error("the Source could not be refreshed");
      calls.push(`plan:${action}`);
      selections.push(selection);
      return planOf(selection, action);
    },
    approvalStatus: async (_selection, action = "install") => {
      calls.push(`approval:${action}`);
      return options.approval ?? "needs approval";
    },
    approve: async (_selection, action = "install") => {
      calls.push(`approve:${action}`);
    },
    executeLifecycle: async (plan) => {
      calls.push(`execute:${plan.action}`);
      return options.execute?.(plan) ?? installed;
    },
  });
  const environment: TuiEnvironment = { projectManifestStore: new EmptyManifestStore(), packages };
  const view = await renderExpanded(
    <CatalogView operations={operationsFor(async () => [...(options.discoverSkills ?? skills)])} sourceId={source.id} environment={environment} />,
  );
  t.after(() => view.unmount());
  return { view, calls, selections };
}

/** Highlights the Package bundle row under the Source's Packages group. */
async function revealBundle(view: Fixture["view"]): Promise<void> {
  await waitForFrame(view.lastFrame, /Packages \(1\)/);
  await moveDownTo(view.lastFrame, view.stdin, /> .*Packages \(1\)/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Package pstack \(pi\)/);
  await moveDownTo(view.lastFrame, view.stdin, /> .*Package pstack \(pi\)/);
}

type Stdin = { write(data: string): void };

async function moveDownTo(lastFrame: () => string | undefined, stdin: Stdin, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    const line = (lastFrame() ?? "").split("\n").find((candidate) => candidate.startsWith("> ")) ?? "";
    if (line.match(pattern)) return;
    const before = lastFrame();
    stdin.write("j");
    await waitForFrame(lastFrame, (next) => next !== before);
  }
  assert.fail("selection never reached the Package bundle row");
}

test("i on a Catalog bundle previews the frozen plan, approves the missing receipt, then runs it", async (t) => {
  const f = await fixture(t);
  await revealBundle(f.view);
  f.view.stdin.write("i");
  const preview = await waitForFrame(f.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  assert.match(preview, /Step 1 \(apply\): \["pi","install","github\.com\/iseoane\/pstack"\]/);
  assert.match(preview, /Executable: \/usr\/bin\/pi/);
  assert.match(preview, /runs a host process/);
  assert.match(preview, /host-only: Agent Depot never manages it/);
  assert.match(preview, /Blast radius: pi plugins\/pstack/);
  assert.match(preview, /Approval: needs approval/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install"]);
  f.view.stdin.write("y");
  const approved = await waitForFrame(f.view.lastFrame, /install pstack\? y\/n/);
  assert.match(approved, /Approval: approved/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install", "approve:install"]);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /pstack: installed \(installed 1\.2\.0\)/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install", "approve:install", "execute:install"]);
  assert.equal(f.selections.length, 1);
  assert.deepEqual(f.selections[0]!.source, { kind: "external", url: source.url });
  assert.deepEqual(f.selections[0]!.version, { policy: "latest" });
  assert.equal(f.selections[0]!.host, "pi");
  assert.equal(f.selections[0]!.host === "pi" ? f.selections[0]!.root : undefined, "plugins/pstack");
});

test("an approved Catalog bundle runs on the first y with no second gate", async (t) => {
  const f = await fixture(t, { approval: "approved" });
  await revealBundle(f.view);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /install pstack\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /pstack: installed \(installed 1\.2\.0\)/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install", "execute:install"]);
});

test("n and Esc at either Catalog bundle gate write and run nothing", async (t) => {
  const f = await fixture(t);
  await revealBundle(f.view);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, /Package action cancelled/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install"]);

  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /install pstack\? y\/n/);
  f.view.stdin.write(ESC);
  await waitForFrame(f.view.lastFrame, /Package action cancelled/);
  assert.ok(!f.calls.some((call) => call.startsWith("execute")), "Esc must not execute");
  assert.ok(!f.calls.some((call) => call.startsWith("approve")), "Esc after approval must not approve again");
});

test("a stale Catalog bundle plan is reported and never executed again", async (t) => {
  const f = await fixture(t, {
    execute: (plan) => ({ status: "stale plan", reason: `the ${plan.action} declaration changed` }),
  });
  await revealBundle(f.view);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /install pstack\? y\/n/);
  f.view.stdin.write("y");
  const frame = await waitForFrame(f.view.lastFrame, /not run:/);
  assert.match(frame, /pstack: install not run: the install declaration changed/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install", "approve:install", "execute:install"]);
});

test("a Catalog bundle planning failure is shown and runs nothing", async (t) => {
  const f = await fixture(t, { planError: true });
  await revealBundle(f.view);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /the Source could not be refreshed/);
  assert.ok(!f.calls.some((call) => call.startsWith("execute")), "planning failed, so nothing runs");
});

test("pressing i on a bundle installs the Package even when loose skills are marked", async (t) => {
  const f = await fixture(t);
  await revealBundle(f.view);
  // Mark the loose skill first, then return to the bundle row.
  await moveDownTo(f.view.lastFrame, f.view.stdin, /loose/);
  f.view.stdin.write(" ");
  await waitForFrame(f.view.lastFrame, /1 selected/);
  const before = f.view.lastFrame();
  f.view.stdin.write("k");
  await waitForFrame(f.view.lastFrame, (next) => next !== before);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install"]);
});
