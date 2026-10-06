import type {
  BundleDescriptor,
  InstalledPackage,
  PackageAction,
  PackageCommand,
  PackageLifecyclePlan,
  PackageLifecycleResult,
  PackageSelection,
} from "../src/package-model.js";
import type { ProfilePackageOperations } from "../src/profile.js";

export const piPackage: PackageSelection = Object.freeze({
  host: "pi",
  root: "plugins/demo",
  source: Object.freeze({ kind: "external", url: "https://example.test/demo.git" }),
  version: Object.freeze({ policy: "latest" }),
});

export const claudePackage: PackageSelection = Object.freeze({
  host: "claude",
  marketplaceRoot: "plugins/other",
  pluginName: "other",
  source: Object.freeze({ kind: "builtin", id: "builtin:agent-depot" }),
  version: Object.freeze({ policy: "fixed", version: "0.3.0" }),
});

/** The whole record, evidence included. Only `selection` is portable. */
export const installedPackage: InstalledPackage = Object.freeze({
  selection: piPackage,
  installId: "pi:demo",
  lastDelegatedCommit: "a".repeat(40),
  verified: Object.freeze({ kind: "manifest-version", version: "1.2.3", declaredBy: "bundle" }),
  verifiedAt: "2026-01-01T00:00:00.000Z",
});

export interface PackagePortEvidence {
  readonly approvals: readonly PackageAction[];
  readonly plans: readonly PackageAction[];
  readonly executions: readonly { readonly action: PackageAction; readonly confirmed: boolean }[];
  readonly listed: number;
}

function fakePlan(selection: PackageSelection, action: PackageAction, commands: readonly PackageCommand[]): PackageLifecyclePlan {
  const coordinates = selection.host === "pi"
    ? { host: "pi" as const, root: selection.root }
    : { host: "claude" as const, marketplaceRoot: selection.marketplaceRoot, pluginName: selection.pluginName };
  const descriptor: BundleDescriptor = { host: selection.host, coordinates, name: "demo",
    components: [], warnings: [], manifestDigest: "a".repeat(64) };
  return { selection, action, descriptor, commands, affects: [], warnings: [], cwd: "/tmp", environment: "linux",
    origin: { manifestDigest: descriptor.manifestDigest, installId: "pi:demo" } };
}

/** A scripted Package port: records every call and answers with the supplied plan steps and result. */
export function fakePackageOperations(options: {
  readonly recorded?: readonly InstalledPackage[];
  readonly commands?: readonly PackageCommand[];
  readonly result?: PackageLifecycleResult;
} = {}): { readonly operations: ProfilePackageOperations; readonly evidence: PackagePortEvidence } {
  const approvals: PackageAction[] = [];
  const plans: PackageAction[] = [];
  const executions: { action: PackageAction; confirmed: boolean }[] = [];
  const evidence = { approvals, plans, executions, listed: 0 };
  const operations: ProfilePackageOperations = {
    async list() {
      evidence.listed += 1;
      return options.recorded ?? [];
    },
    async approve(_selection, action = "install") {
      approvals.push(action);
    },
    async planLifecycle(selection, action) {
      plans.push(action);
      return fakePlan(selection, action, options.commands ?? []);
    },
    async executeLifecycle(plan, confirmed) {
      executions.push({ action: plan.action, confirmed });
      return options.result ?? { status: "selected" };
    },
  };
  return { operations, evidence };
}
