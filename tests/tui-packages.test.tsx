import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

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
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { fakePackageOperations } from "./fake-package-operations.js";
import { waitForFrame } from "./wait-for-frame.js";

const ENTER = "\r";
const ESC = "\u001B";

const selection: PackageSelection = {
  host: "pi",
  root: "plugins/pstack",
  source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
  version: { policy: "latest" },
};

const descriptor: BundleDescriptor = {
  host: "pi",
  coordinates: { host: "pi", root: "plugins/pstack" },
  name: "pstack",
  version: { kind: "manifest-version", version: "1.1.0", declaredBy: "bundle" },
  components: [
    { kind: "skills", ownership: "skill-category", effect: "instruction", paths: ["plugins/pstack/skills"], skillNames: ["how"] },
    { kind: "extensions", ownership: "host-only", effect: "executable", paths: ["plugins/pstack/extensions/index.ts"] },
  ],
  warnings: [],
  installable: true,
  manifestDigest: "a".repeat(64),
};

const record: InstalledPackage = {
  selection,
  installId: "pi:github.com/iseoane/pstack",
  verified: { kind: "manifest-version", version: "1.0.0", declaredBy: "bundle" },
  verifiedAt: "2026-01-01T00:00:00.000Z",
};

function plan(action: PackageAction): PackageLifecyclePlan {
  const args = action === "install" || action === "update" || action === "uninstall"
    ? [action === "uninstall" ? "remove" : action, "github.com/iseoane/pstack"]
    : [];
  return {
    selection,
    action,
    descriptor,
    commands: args.length === 0 ? [] : [{
      purpose: action === "uninstall" ? "remove" : "apply",
      executable: "pi",
      resolvedPath: "/usr/bin/pi",
      args,
      summary: `pi ${action}`,
    }],
    affects: [{ host: "pi", root: "plugins/pstack" }],
    warnings: [],
    cwd: "/home/user",
    environment: "linux",
    origin: { manifestDigest: descriptor.manifestDigest, installId: record.installId, resolvedCommit: "b".repeat(40) },
  };
}

const resultOf = (action: PackageAction): PackageLifecycleResult => {
  if (action === "uninstall") return { status: "removed" };
  if (action === "update") {
    return { status: "updated", previous: { kind: "installed", version: "1.0.0" }, verified: { kind: "installed", version: "1.1.0" } };
  }
  return { status: "installed", verified: { kind: "installed", version: "1.0.0" } };
};

interface Fixture {
  readonly view: ReturnType<typeof render>;
  readonly calls: string[];
}

/** A fake PackageOperations that records every lifecycle call; the reads are scripted. */
function scripted(calls: string[], overrides: Partial<PackageOperations>): PackageOperations {
  return fakePackageOperations({
    list: async () => [record],
    inspect: async (): Promise<PackageInspection> => ({
      descriptor,
      installed: { kind: "installed", version: "1.0.0" },
      available: { kind: "git-commit", commit: "abcdef1234567890" },
      approval: "needs approval",
    }),
    planLifecycle: async (_selection, action) => {
      calls.push(`plan:${action}`);
      return plan(action);
    },
    approvalStatus: async (_selection, action = "install") => {
      calls.push(`approval:${action}`);
      return action === "install" ? "needs approval" : "approved";
    },
    approve: async (_selection, action = "install") => {
      calls.push(`approve:${action}`);
    },
    executeLifecycle: async (lifecycle) => {
      calls.push(`execute:${lifecycle.action}`);
      return resultOf(lifecycle.action);
    },
    forget: async () => {
      calls.push("forget");
    },
    ...overrides,
  });
}

/** Renders the Installations view over one recorded Package with a fake PackageOperations. */
async function fixture(t: TestContext, overrides: Partial<PackageOperations> = {}): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "tui-packages-"));
  const calls: string[] = [];
  const packages = scripted(calls, overrides);
  const operations: SourceOperations = {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return [BUILT_IN_SOURCE];
    },
    async refreshSource() {
      throw new Error("unused");
    },
    async selectSources() {
      return [BUILT_IN_SOURCE];
    },
    async listUserGlobalInstallations() {
      return [];
    },
  };
  const view = render(
    <InstallationsView operations={operations} environment={{ homeDirectory: home, projectRoot: home, packages }} listHeight={24} />,
  );
  t.after(async () => {
    view.unmount();
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  return { view, calls };
}

type Stdin = { write(data: string): void };

/** Presses j until the selected line matches, waiting for each move to render. */
async function moveDownTo(lastFrame: () => string | undefined, stdin: Stdin, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    const frame = lastFrame() ?? "";
    if ((frame.split("\n").find((line) => line.startsWith("> ")) ?? "").match(pattern)) return;
    stdin.write("j");
    await waitForFrame(lastFrame, (next) => next !== frame);
  }
  assert.fail("selection never reached the expected line");
}

/** Opens the Packages group and highlights the Package row. */
async function revealPackage(view: Fixture["view"]): Promise<void> {
  await waitForFrame(view.lastFrame, /Packages \(user-global\)/);
  await moveDownTo(view.lastFrame, view.stdin, /> .*Packages \(user-global\)/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /pstack/);
  await moveDownTo(view.lastFrame, view.stdin, /> .*pstack/);
}

test("an unversioned Package row reports the host evidence and never guesses the status", async (t) => {
  const f = await fixture(t, {
    inspect: async (): Promise<PackageInspection> => ({
      descriptor,
      installed: { kind: "installed" },
      available: { kind: "git-commit", commit: "abcdef1234567890" },
      approval: "needs approval",
    }),
  });
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  const frame = await waitForFrame(f.view.lastFrame, /installed with no version evidence/);
  assert.match(frame, /pi {2}installed with no version evidence {2}available abcdef1 {2}cannot assess/);
});

test("a Package row shows the drift when the bundle no longer resolves", async (t) => {
  const f = await fixture(t, {
    inspect: async (): Promise<PackageInspection> => ({
      installed: { kind: "unknown", reason: "the bundle could not be resolved" },
      approval: "needs approval",
      drift: "Source \"git:1\" no longer provides a pi Package at \"plugins/pstack\"",
    }),
  });
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  const frame = await waitForFrame(f.view.lastFrame, /drift:/);
  assert.match(frame, /unknown \(the bundle could not be resolved\)/);
  assert.match(frame, /drift: Source "git:1" no longer provides a pi Package/);
});

test("i previews the frozen install declaration, approves it, then confirms before running", async (t) => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
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
  await waitForFrame(f.view.lastFrame, /pstack: installed \(installed 1\.0\.0\)/);
  assert.deepEqual(f.calls, ["plan:install", "approval:install", "approve:install", "execute:install"]);
});

test("U updates and u uninstalls an approved Package with one confirmation each", async (t) => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  f.view.stdin.write("U");
  await waitForFrame(f.view.lastFrame, /update pstack\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /pstack: updated \(installed 1\.0\.0 -> installed 1\.1\.0\)/);
  f.view.stdin.write("u");
  await waitForFrame(f.view.lastFrame, /uninstall pstack\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /pstack: removed/);
  assert.deepEqual(f.calls, [
    "plan:update", "approval:update", "execute:update",
    "plan:uninstall", "approval:uninstall", "execute:uninstall",
  ]);
});

test("f forgets only the selection record and runs no host command", async (t) => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  f.view.stdin.write("f");
  const preview = await waitForFrame(f.view.lastFrame, /Forget the selection record of pstack\? y\/n/);
  assert.match(preview, /Forgetting drops the Agent Depot selection record only/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Forgot pstack; no host command ran/);
  assert.deepEqual(f.calls, ["forget"]);
});

test("Enter approves the install declaration without executing it", async (t) => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  f.view.stdin.write(ENTER);
  await waitForFrame(f.view.lastFrame, /Approve this install declaration for pstack\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Approved the install declaration of pstack/);
  assert.deepEqual(f.calls, ["plan:install", "approve:install"]);
});

test("n and Esc cancel at every Package confirmation without approving or running", async (t) => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /install pstack\? y\/n/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, /Package action cancelled/);
  assert.ok(!f.calls.some((call) => call.startsWith("execute")), "n must not execute");
  f.view.stdin.write("f");
  await waitForFrame(f.view.lastFrame, /Forget the selection record of pstack\? y\/n/);
  f.view.stdin.write(ESC);
  await waitForFrame(f.view.lastFrame, /Package action cancelled/);
  assert.ok(!f.calls.includes("forget"), "Esc must not forget");
  f.view.stdin.write("U");
  await waitForFrame(f.view.lastFrame, /update pstack\? y\/n/);
  f.view.stdin.write(ESC);
  await waitForFrame(f.view.lastFrame, /Package action cancelled/);
  assert.ok(!f.calls.includes("execute:update"), "Esc must not update");
});

test("listing and reloading Packages run no lifecycle step", async (t) => {
  const calls: string[] = [];
  const f = await fixture(t, {
    list: async () => [record],
    inspect: async (): Promise<PackageInspection> => ({ descriptor, installed: { kind: "absent" }, approval: "needs approval" }),
    planLifecycle: async () => {
      calls.push("plan");
      throw new Error("planLifecycle must not run while listing");
    },
    approve: async () => {
      calls.push("approve");
    },
    executeLifecycle: async () => {
      calls.push("execute");
      return { status: "not confirmed" };
    },
    forget: async () => {
      calls.push("forget");
    },
  });
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  assert.deepEqual(calls, []);
});

test("a Package list failure is confined to the Packages group", async (t) => {
  const f = await fixture(t, {
    list: async () => {
      throw new Error("packages.json is not readable");
    },
  });
  const frame = await waitForFrame(f.view.lastFrame, /packages\.json is not readable/);
  assert.match(frame, /Packages \(user-global\) \(0\)/);
});

test("a Package row is not markable for bulk actions", async (t) => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, /Packages \(user-global\) \(1\)/);
  await revealPackage(f.view);
  f.view.stdin.write(" ");
  await waitForFrame(f.view.lastFrame, /Packages act from their own row; marking is not supported/);
  assert.ok(!f.view.lastFrame()!.includes("[x]"), "no Package row is marked");
});
