import type {
  BundleDescriptor,
  InstalledPackage,
  PackageAction,
  PackageCommand,
  PackageLifecyclePlan,
  PackageLifecycleResult,
  PackageSelection,
} from "../src/package-model.js";
import type { GitSource } from "../src/git-source.js";
import { createPackageOperations, type PackageOperations } from "../src/package-flow.js";
import type { SourceContentAccess } from "../src/skill-discovery.js";
import type { SourceOperations } from "../src/sources.js";
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

export const hostedSource: GitSource = Object.freeze({
  id: "git:example.test/demo-bundle",
  kind: "git",
  url: "https://example.test/demo-bundle",
});
export const hostedSelection: PackageSelection = Object.freeze({ host: "pi", root: "",
  source: Object.freeze({ kind: "external", url: hostedSource.url }), version: Object.freeze({ policy: "latest" }) });

export interface PackageSide {
  readonly operations: PackageOperations;
  readonly sourceOperations: SourceOperations;
  readonly calls: readonly (readonly string[])[];
  readonly stateDirectory: string;
}

/** One machine: its own state directory, host state and process runner, over one shared Source. */
export async function createPackageSide(options: {
  readonly homeDirectory: string;
  readonly stateDirectory: string;
  readonly bundleVersion?: string;
}): Promise<PackageSide> {
  const calls: string[][] = [];
  const contentAccess: SourceContentAccess = {
    readSnapshot: async () => Object.freeze([
      Object.freeze({ path: "package.json", content: JSON.stringify({ name: "demo-bundle", version: options.bundleVersion ?? "1.0.0", pi: { skills: "skills" } }) }),
      Object.freeze({ path: "skills/demo/SKILL.md", content: "---\nname: demo\ndescription: demo fixture\n---\n" }),
    ]),
    readResolvedVersion: async () => Object.freeze({ kind: "git-commit" as const, commit: "a".repeat(40) }),
  };
  const sourceOperations: SourceOperations = {
    addGitSource: async () => hostedSource,
    listSources: async () => Object.freeze([hostedSource]),
    refreshSource: async () => hostedSource,
    selectSources: async () => Object.freeze([hostedSource]),
    resolveProjectSource: async () => hostedSource,
    refreshProjectSource: async () => hostedSource,
    listUserGlobalInstallations: async () => Object.freeze([]),
  };
  const operations: PackageOperations = createPackageOperations({
    homeDirectory: options.homeDirectory,
    stateDirectory: options.stateDirectory,
    platform: "linux",
    isWsl: false,
    sourceOperations,
    sourceContentAccess: contentAccess,
    resolveExecutable: async name => `/usr/bin/${name}`,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", outputTooLarge: false };
    },
    readHostStateFile: async filePath => {
      const error = new Error(`ENOENT: no such file or directory, open ${JSON.stringify(filePath)}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  return { operations, sourceOperations, calls, stateDirectory: options.stateDirectory };
}
