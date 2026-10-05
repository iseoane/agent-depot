import { homedir } from "node:os";

import { sameAppVersion } from "./app-version.js";
import { createPortableExecutableResolver } from "./executable-resolution.js";
import { claudeMarketplaceName, discoverBundlesInSnapshot } from "./package-bundles.js";
import { sourceBundleScope } from "./package-content.js";
import {
  affectedBy,
  classifyUpdate,
  hostInstallId,
  packageApprovalDigest,
  planHostSteps,
  PackagePlanError,
  type HostPlanResolution,
} from "./package-host-plans.js";
import { findInstalledBundle, readHostInstallView, type HostInstallView } from "./package-host-state.js";
import {
  bundleRoot,
  describeCoordinates,
  selectionKey,
  type BundleDescriptor,
  type InstalledBundleEvidence,
  type InstalledPackage,
  type PackageAction,
  type PackageCommand,
  type PackageCoordinates,
  type PackageDeclaration,
  type PackageInspection,
  type PackageLifecyclePlan,
  type PackageLifecycleResult,
  type PackagePlanOrigin,
  type PackageSelection,
  type PackageUpdateCheck,
  type PackageVersionEvidence,
} from "./package-model.js";
import {
  defaultPackageStateDirectory,
  PackageStateStore,
  type PackageApprovalStatus,
} from "./package-state.js";
import { runProcess } from "./process-runner.js";
import { createSourceContentAccess, type SourceContentAccess, type SourceContentFile } from "./skill-discovery.js";
import {
  createSourceOperations,
  resolveProjectSource,
  type Source,
  type SourceOperations,
} from "./sources.js";
import type { ProjectSource } from "./project-manifest.js";

const PACKAGE_OUTPUT_LIMIT = 1024 * 1024;
const DIAGNOSTIC_BYTES = 4096;
const WSL_EXECUTABLE_REASON = "will not run (Windows executable on WSL)";

/** Everything the Package flow reads or writes; every field has a production default. */
export interface PackageEnvironment {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoot?: string;
  readonly stateDirectory?: string;
  readonly runner?: typeof runProcess;
  readonly resolveExecutable?: (name: string) => Promise<string | undefined>;
  readonly sourceOperations?: SourceOperations;
  /** Reads the immutable Source snapshot the discovery pass and the guard share. */
  readonly sourceContentAccess?: SourceContentAccess;
  readonly readHostStateFile?: (path: string) => Promise<string>;
}

export interface PackageOperations {
  /** Bundles in the selected Sources. Runs no host command. */
  discover(sourceIds: readonly string[]): Promise<readonly BundleDescriptor[]>;
  /** Recorded selections, in selection-key order. */
  list(): Promise<readonly InstalledPackage[]>;
  /** One selection against the live Source. Runs no host command. */
  inspect(selection: PackageSelection): Promise<PackageInspection>;
  /** The receipt status for one action's derived declaration. */
  approvalStatus(selection: PackageSelection, action?: PackageAction): Promise<PackageApprovalStatus>;
  /** Re-derives the declaration from the current snapshot and writes the receipt. */
  approve(selection: PackageSelection, action?: PackageAction): Promise<void>;
  /** Refreshes the Source first, per ADR 0004, then freezes the plan. */
  planLifecycle(selection: PackageSelection, action: PackageAction): Promise<PackageLifecyclePlan>;
  /** Requires confirmation and a current receipt, re-derives, runs, re-observes, records. */
  executeLifecycle(plan: PackageLifecyclePlan, confirmed: boolean): Promise<PackageLifecycleResult>;
  /** Drops the selection record. Runs no host command. */
  forget(selection: PackageSelection, confirmed: boolean): Promise<void>;
  /** Batched assessment with per-Package failure isolation. */
  checkUpdates(selections?: readonly PackageSelection[]): Promise<readonly PackageUpdateCheck[]>;
}

interface DerivedBundle {
  readonly source: Source;
  readonly files: readonly SourceContentFile[];
  readonly descriptor: BundleDescriptor;
  readonly resolvedCommit?: string;
  readonly available?: PackageVersionEvidence;
  readonly marketplace: HostPlanResolution;
}

interface DerivedPlan {
  readonly plan: PackageLifecyclePlan;
  readonly declaration: PackageDeclaration;
  readonly digest: string;
  readonly bundle: DerivedBundle;
  readonly available?: PackageVersionEvidence;
}

interface OutcomeContext {
  readonly action: PackageAction;
  readonly selection: PackageSelection;
  readonly descriptor: BundleDescriptor;
  readonly origin: PackagePlanOrigin;
  readonly available?: PackageVersionEvidence;
  readonly previous?: InstalledBundleEvidence;
}

export function createPackageOperations(environment: PackageEnvironment = {}): PackageOperations {
  const platform = environment.platform ?? process.platform;
  const home = environment.homeDirectory ?? homedir();
  const isWsl = environment.isWsl ?? (
    platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
  const stateDirectory = environment.stateDirectory ?? defaultPackageStateDirectory(process.env, platform, home);
  const state = new PackageStateStore(stateDirectory);
  const runner = environment.runner ?? runProcess;
  const contentAccess = environment.sourceContentAccess ?? createSourceContentAccess();
  const sourceOperations = environment.sourceOperations ?? createSourceOperations({
    ...(environment.homeDirectory === undefined ? {} : { homeDirectory: environment.homeDirectory }),
    sourceContentAccess: contentAccess,
  });
  const resolve = createPortableExecutableResolver({
    platform,
    isWsl,
    ...(environment.wslMountRoot === undefined ? {} : { wslMountRoot: environment.wslMountRoot }),
    ...(environment.resolveExecutable === undefined ? {} : { resolveExecutable: environment.resolveExecutable }),
  });
  const readHostView = (): Promise<HostInstallView> => readHostInstallView({
    ...(environment.homeDirectory === undefined ? {} : { homeDirectory: environment.homeDirectory }),
    ...(environment.readHostStateFile === undefined ? {} : { readHostStateFile: environment.readHostStateFile }),
  });

  async function resolveSourceFor(projectSource: ProjectSource): Promise<Source> {
    return sourceOperations.resolveProjectSource
      ? await sourceOperations.resolveProjectSource(projectSource)
      : resolveProjectSource(projectSource);
  }

  /** ADR 0004: a preview that leads to a write refreshes the Source first. */
  async function refreshSourceFor(selection: PackageSelection): Promise<Source> {
    const source = await resolveSourceFor(selection.source);
    if (source.kind === "builtin" || sourceOperations.refreshProjectSource === undefined) {
      return source;
    }
    return await sourceOperations.refreshProjectSource(selection.source);
  }

  async function readResolvedCommit(source: Source): Promise<string | undefined> {
    if (source.kind === "builtin" || contentAccess.readResolvedVersion === undefined) {
      return undefined;
    }
    const evidence = await contentAccess.readResolvedVersion(source);
    return evidence?.kind === "git-commit" ? evidence.commit : undefined;
  }

  async function deriveBundle(selection: PackageSelection, source: Source): Promise<DerivedBundle> {
    const files = Object.freeze([...(await contentAccess.readSnapshot(source))]);
    const coordinates = coordinatesOf(selection);
    const descriptor = discoverBundlesInSnapshot(files, sourceBundleScope(source))
      .find((candidate) => sameCoordinates(candidate.coordinates, coordinates));
    if (descriptor === undefined) {
      throw new PackagePlanError(
        `Source ${JSON.stringify(source.id)} no longer provides a ${selection.host} Package at ${JSON.stringify(bundleRoot(coordinates))}`,
      );
    }
    const resolvedCommit = await readResolvedCommit(source);
    const available = availableEvidence(descriptor, resolvedCommit);
    return Object.freeze({
      source,
      files,
      descriptor,
      ...(resolvedCommit === undefined ? {} : { resolvedCommit }),
      ...(available === undefined ? {} : { available }),
      marketplace: marketplaceResolution(descriptor, files),
    });
  }

  async function planFromBundle(
    selection: PackageSelection,
    action: PackageAction,
    bundle: DerivedBundle,
    view: HostInstallView,
  ): Promise<DerivedPlan> {
    const commands = Object.freeze(
      planHostSteps(action, bundle.descriptor, selection, view, bundle.marketplace)
        .map((argv) => toCommand(argv, action)),
    );
    const origin: PackagePlanOrigin = Object.freeze({
      manifestDigest: bundle.descriptor.manifestDigest,
      installId: hostInstallId(bundle.descriptor, selection, view, bundle.marketplace),
      ...(bundle.resolvedCommit === undefined ? {} : { resolvedCommit: bundle.resolvedCommit }),
    });
    const installed = findInstalledBundle(view, bundle.descriptor, selection);
    const plan: PackageLifecyclePlan = Object.freeze({
      selection,
      action,
      descriptor: bundle.descriptor,
      commands,
      affects: affectedBy(action, selection, (await state.list()).map((record) => record.selection)),
      warnings: bundle.descriptor.warnings,
      cwd: home,
      environment: isWsl ? "linux (WSL)" : platform,
      origin,
      ...(actionSatisfied(action, installed) ? { skipExecution: true } : {}),
    });
    const declaration = declarationFor(selection, bundle.descriptor, commands);
    return Object.freeze({
      plan,
      declaration,
      digest: packageApprovalDigest(declaration),
      bundle,
      ...(bundle.available === undefined ? {} : { available: bundle.available }),
    });
  }

  async function derivePlan(
    selection: PackageSelection,
    action: PackageAction,
    refresh: boolean,
  ): Promise<DerivedPlan> {
    const source = refresh ? await refreshSourceFor(selection) : await resolveSourceFor(selection.source);
    const bundle = await deriveBundle(selection, source);
    return await planFromBundle(selection, action, bundle, await readHostView());
  }

  async function inspect(selection: PackageSelection): Promise<PackageInspection> {
    let bundle: DerivedBundle | undefined;
    let drift: string | undefined;
    let approval: PackageApprovalStatus = "needs approval";
    let installId: string | undefined;
    const view = await readHostView();
    try {
      bundle = await deriveBundle(selection, await resolveSourceFor(selection.source));
    } catch (error) {
      drift = reasonOf(error);
    }
    if (bundle !== undefined) {
      try {
        const derived = await planFromBundle(selection, "install", bundle, view);
        approval = await state.approvalStatus(derived.digest);
        installId = derived.plan.origin.installId;
      } catch (error) {
        drift ??= reasonOf(error);
      }
    }
    const record = await state.find(selection);
    const identityDrift = record === undefined || installId === undefined || record.installId === installId
      ? undefined
      : `The recorded install identity ${JSON.stringify(record.installId)} no longer matches ${JSON.stringify(installId)}`;
    const installed = bundle === undefined
      ? Object.freeze({ kind: "unknown" as const, reason: drift ?? "the bundle could not be resolved" })
      : findInstalledBundle(view, bundle.descriptor, selection);
    return Object.freeze({
      ...(bundle === undefined ? {} : { descriptor: bundle.descriptor }),
      installed,
      ...(bundle?.available === undefined ? {} : { available: bundle.available }),
      approval,
      ...((drift ?? identityDrift) === undefined ? {} : { drift: drift ?? identityDrift }),
    });
  }

  async function checkOne(record: InstalledPackage): Promise<PackageUpdateCheck> {
    try {
      const inspection = await inspect(record.selection);
      const status = classifyUpdate(inspection.installed, inspection.available);
      return Object.freeze({
        installed: record,
        status,
        ...(inspection.available === undefined ? {} : { available: inspection.available }),
        ...(status === "unknown" ? { reason: inspection.drift ?? describeEvidence(inspection.installed) } : {}),
      });
    } catch (error) {
      return Object.freeze({
        installed: record,
        status: "unknown" as const,
        reason: `The update check failed: ${reasonOf(error)}`,
      });
    }
  }

  async function writeSelection(context: OutcomeContext): Promise<void> {
    await state.upsert({
      selection: context.selection,
      installId: context.origin.installId,
      ...(context.origin.resolvedCommit === undefined ? {} : { lastDelegatedCommit: context.origin.resolvedCommit }),
      ...(context.available === undefined ? {} : { verified: context.available }),
    });
  }

  async function recordOutcome(
    context: OutcomeContext,
    observed: InstalledBundleEvidence,
  ): Promise<PackageLifecycleResult> {
    switch (context.action) {
      case "install": {
        if (observed.kind !== "installed") {
          return { status: "failed", reason: `The host does not report ${describeCoordinates(context.selection)} installed (${describeEvidence(observed)})` };
        }
        await writeSelection(context);
        return Object.freeze({ status: "installed", verified: observed });
      }
      case "update": {
        if (observed.kind !== "installed") {
          return { status: "failed", reason: `The update left no installed ${describeCoordinates(context.selection)} (${describeEvidence(observed)})` };
        }
        if (context.previous !== undefined && sameInstalledEvidence(context.previous, observed)) {
          return {
            status: "failed",
            reason: `The observed version did not change (${describeEvidence(observed)}); the selection record was left untouched`,
          };
        }
        await writeSelection(context);
        return Object.freeze({
          status: "updated",
          previous: context.previous ?? Object.freeze({ kind: "absent" as const }),
          verified: observed,
        });
      }
      case "uninstall": {
        if (observed.kind !== "absent") {
          return { status: "failed", reason: `The host still reports ${describeCoordinates(context.selection)} (${describeEvidence(observed)})` };
        }
        await state.drop(context.selection);
        return Object.freeze({ status: "removed" });
      }
      case "select": {
        await writeSelection(context);
        return Object.freeze({ status: "selected" });
      }
      case "forget": {
        await state.drop(context.selection);
        return Object.freeze({ status: "forgotten" });
      }
    }
  }

  function contextFromDerived(
    derived: DerivedPlan,
    action: PackageAction,
    previous?: InstalledBundleEvidence,
  ): OutcomeContext {
    return {
      action,
      selection: derived.plan.selection,
      descriptor: derived.plan.descriptor,
      origin: derived.plan.origin,
      ...(derived.available === undefined ? {} : { available: derived.available }),
      ...(previous === undefined ? {} : { previous }),
    };
  }

  async function completeSkipped(context: OutcomeContext): Promise<PackageLifecycleResult> {
    switch (context.action) {
      case "install": {
        await writeSelection(context);
        const view = await readHostView();
        return Object.freeze({
          status: "installed",
          verified: findInstalledBundle(view, context.descriptor, context.selection),
        });
      }
      case "select": {
        await writeSelection(context);
        return Object.freeze({ status: "selected" });
      }
      case "uninstall": {
        await state.drop(context.selection);
        return Object.freeze({ status: "removed" });
      }
      case "update":
      case "forget": {
        return await recordOutcome(
          context,
          findInstalledBundle(await readHostView(), context.descriptor, context.selection),
        );
      }
    }
  }

  return {
    async discover(sourceIds: readonly string[]): Promise<readonly BundleDescriptor[]> {
      const descriptors: BundleDescriptor[] = [];
      for (const source of await sourceOperations.selectSources(sourceIds)) {
        descriptors.push(...discoverBundlesInSnapshot(await contentAccess.readSnapshot(source), sourceBundleScope(source)));
      }
      return Object.freeze(descriptors);
    },

    async list(): Promise<readonly InstalledPackage[]> {
      return await state.list();
    },

    inspect,

    async approvalStatus(
      selection: PackageSelection,
      action: PackageAction = "install",
    ): Promise<PackageApprovalStatus> {
      const derived = await derivePlan(selection, action, false);
      return await state.approvalStatus(derived.digest);
    },

    async approve(selection: PackageSelection, action: PackageAction = "install"): Promise<void> {
      const derived = await derivePlan(selection, action, false);
      await state.approve(derived.digest);
    },

    async planLifecycle(selection: PackageSelection, action: PackageAction): Promise<PackageLifecyclePlan> {
      return (await derivePlan(selection, action, true)).plan;
    },

    async executeLifecycle(plan: PackageLifecyclePlan, confirmed: boolean): Promise<PackageLifecycleResult> {
      if (!confirmed) {
        return Object.freeze({ status: "not confirmed" });
      }
      const fresh = await derivePlan(plan.selection, plan.action, false);
      const difference = planDifference(plan, fresh);
      if (difference !== undefined) {
        return Object.freeze({ status: "stale plan", reason: difference });
      }
      if (await state.approvalStatus(fresh.digest) !== "approved") {
        throw new PackagePlanError(
          `The ${plan.action} plan for ${describeCoordinates(plan.selection)} is not approved; review it and approve the current declaration first`,
        );
      }

      const previous = findInstalledBundle(await readHostView(), fresh.plan.descriptor, plan.selection);
      const context = contextFromDerived(fresh, plan.action, previous);
      if (fresh.plan.skipExecution === true) {
        return await completeSkipped(context);
      }

      for (const command of fresh.plan.commands) {
        const resolution = await resolve(command.executable);
        if (resolution.blocked) {
          return { status: "manual required", reason: blockedReason(command.executable, plan.action) };
        }
        if (resolution.executable === undefined) {
          return { status: "manual required", reason: missingExecutableReason(command.executable, plan.action) };
        }
        let result;
        try {
          result = await runner(resolution.executable, command.args, {
            cwd: plan.cwd,
            captureStdout: true,
            maxOutputBytes: PACKAGE_OUTPUT_LIMIT,
            maxStderrBytes: PACKAGE_OUTPUT_LIMIT,
          });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === undefined || !["ENOENT", "EACCES", "ENOEXEC", "EPERM"].includes(code)) {
            throw error;
          }
          const detail = error instanceof Error ? error.message : String(error);
          return {
            status: "manual required",
            reason: `Cannot run ${JSON.stringify(command.executable)} for the Package ${plan.action} (${code}): ${detail}`,
          };
        }
        if (result.code !== 0 || result.signal || result.outputTooLarge) {
          const failure = result.outputTooLarge
            ? `output exceeded ${PACKAGE_OUTPUT_LIMIT} bytes`
            : `exit ${result.code}, signal ${result.signal}`;
          const output = [
            result.stdout.subarray(-DIAGNOSTIC_BYTES).toString("utf8"),
            Buffer.from(result.stderr).subarray(-DIAGNOSTIC_BYTES).toString("utf8"),
          ].join(" ").trim();
          return {
            status: "failed",
            reason: `The host command ${JSON.stringify(command.executable)} failed (${failure})`,
            ...(output === "" ? {} : { output }),
          };
        }
      }
      return await recordOutcome(
        context,
        findInstalledBundle(await readHostView(), fresh.plan.descriptor, plan.selection),
      );
    },

    async forget(selection: PackageSelection, confirmed: boolean): Promise<void> {
      if (!confirmed) {
        throw new PackagePlanError("Forgetting a Package requires explicit confirmation; no record was changed");
      }
      await state.drop(selection);
    },

    async checkUpdates(selections?: readonly PackageSelection[]): Promise<readonly PackageUpdateCheck[]> {
      const records = await state.list();
      const selected = selections === undefined
        ? records
        : records.filter((record) => selections.some((selection) => selectionKey(selection) === selectionKey(record.selection)));
      return Object.freeze(await Promise.all(selected.map(async (record) => await checkOne(record))));
    },
  };
}

function coordinatesOf(selection: PackageSelection): PackageCoordinates {
  return selection.host === "pi"
    ? Object.freeze({ host: selection.host, root: selection.root })
    : Object.freeze({ host: selection.host, marketplaceRoot: selection.marketplaceRoot, pluginName: selection.pluginName });
}

function sameCoordinates(left: PackageCoordinates, right: PackageCoordinates): boolean {
  if (left.host === "pi" && right.host === "pi") {
    return left.root === right.root;
  }
  if (left.host === "claude" && right.host === "claude") {
    return left.marketplaceRoot === right.marketplaceRoot && left.pluginName === right.pluginName;
  }
  return false;
}

function availableEvidence(
  descriptor: BundleDescriptor,
  resolvedCommit: string | undefined,
): PackageVersionEvidence | undefined {
  if (descriptor.version !== undefined) {
    return descriptor.version;
  }
  return resolvedCommit === undefined ? undefined : Object.freeze({ kind: "git-commit", commit: resolvedCommit });
}

/** The marketplace name lives in the Source's own manifest, never in host state before the first add. */
function marketplaceResolution(
  descriptor: BundleDescriptor,
  files: readonly SourceContentFile[],
): HostPlanResolution {
  const coordinates = descriptor.coordinates;
  if (coordinates.host !== "claude") {
    return Object.freeze({});
  }
  const root = coordinates.marketplaceRoot;
  const filePath = root === "" ? ".claude-plugin/marketplace.json" : `${root}/.claude-plugin/marketplace.json`;
  const raw = files.find((file) => file.path === filePath)?.content;
  if (raw === undefined) {
    return Object.freeze({});
  }
  const name = claudeMarketplaceName(raw);
  return Object.freeze(name === undefined ? {} : { marketplaceName: name });
}

function declarationFor(
  selection: PackageSelection,
  descriptor: BundleDescriptor,
  commands: readonly PackageCommand[],
): PackageDeclaration {
  const source = declarationSource(selection.source);
  return Object.freeze({
    ...source,
    coordinates: coordinatesOf(selection),
    manifestDigest: descriptor.manifestDigest,
    argv: Object.freeze(commands.map((command) => Object.freeze([command.executable, ...command.args]))),
  });
}

function declarationSource(source: ProjectSource): { readonly sourceUrl: string; readonly ref?: string } {
  if (source.kind === "builtin") {
    return Object.freeze({ sourceUrl: "" });
  }
  if ("url" in source) {
    return Object.freeze({ sourceUrl: source.url, ...(source.ref === undefined ? {} : { ref: source.ref }) });
  }
  return Object.freeze({ sourceUrl: source.path, ...(source.ref === undefined ? {} : { ref: source.ref }) });
}

function toCommand(argv: readonly string[], action: PackageAction): PackageCommand {
  const [executable, ...args] = argv;
  if (executable === undefined) {
    throw new PackagePlanError("A host step produced an empty argv");
  }
  return Object.freeze({
    purpose: commandPurpose(action, executable, args),
    executable,
    args: Object.freeze(args),
    summary: `${executable} ${args.join(" ")}`.trim(),
  });
}

function commandPurpose(action: PackageAction, executable: string, args: readonly string[]): PackageCommand["purpose"] {
  if (action === "uninstall") {
    return "remove";
  }
  return executable === "claude" && args[0] === "plugin" && args[1] === "marketplace" ? "register" : "apply";
}

function actionSatisfied(action: PackageAction, installed: InstalledBundleEvidence): boolean {
  switch (action) {
    case "install": {
      return installed.kind === "installed";
    }
    case "uninstall": {
      return installed.kind === "absent";
    }
    case "select": {
      return true;
    }
    case "update":
    case "forget": {
      return false;
    }
  }
}

/** The exact recheck issue 08 pins: manifest digest, install id, resolved commit, ordered steps. */
function planDifference(plan: PackageLifecyclePlan, fresh: DerivedPlan): string | undefined {
  if (fresh.plan.origin.manifestDigest !== plan.origin.manifestDigest) {
    return "The bundle manifest changed since the plan was shown";
  }
  if (fresh.plan.origin.installId !== plan.origin.installId) {
    return "The host install identity changed since the plan was shown";
  }
  if (fresh.plan.origin.resolvedCommit !== plan.origin.resolvedCommit) {
    return "The resolved Source commit changed since the plan was shown";
  }
  if (fresh.plan.commands.length !== plan.commands.length) {
    return "The ordered host steps changed since the plan was shown";
  }
  for (const [index, command] of fresh.plan.commands.entries()) {
    const shown = plan.commands[index];
    if (shown === undefined || shown.executable !== command.executable
      || shown.args.length !== command.args.length
      || shown.args.some((argument, argumentIndex) => argument !== command.args[argumentIndex])) {
      return `Host step ${index + 1} changed since the plan was shown`;
    }
  }
  return undefined;
}

function sameInstalledEvidence(left: InstalledBundleEvidence, right: InstalledBundleEvidence): boolean {
  if (left.kind !== "installed" || right.kind !== "installed") {
    return false;
  }
  if (left.version !== undefined && right.version !== undefined) {
    return sameAppVersion(left.version, right.version);
  }
  if (left.commit !== undefined && right.commit !== undefined) {
    return left.commit.trim().toLowerCase() === right.commit.trim().toLowerCase();
  }
  return false;
}

function describeEvidence(evidence: InstalledBundleEvidence): string {
  switch (evidence.kind) {
    case "installed": {
      if (evidence.version !== undefined) {
        return `installed ${JSON.stringify(evidence.version)}`;
      }
      if (evidence.commit !== undefined) {
        return `installed at commit ${evidence.commit}`;
      }
      return "installed with no version evidence";
    }
    case "absent": {
      return "not installed";
    }
    case "unknown": {
      return `unknown (${evidence.reason})`;
    }
  }
}

function blockedReason(executable: string, action: PackageAction): string {
  return `Cannot run ${JSON.stringify(executable)} for the Package ${action}: ${WSL_EXECUTABLE_REASON}; run the host command manually`;
}

function missingExecutableReason(executable: string, action: PackageAction): string {
  return `Required executable ${JSON.stringify(executable)} for the Package ${action} was not found or could not be started. Install it or make it available on the PATH used by Agent Depot, then retry.`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
