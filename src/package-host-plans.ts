import { createHash } from "node:crypto";

import { compareAppVersions, sameAppVersion } from "./app-version.js";
import {
  claudeMarketplaceNamesForSource,
  piSourceIdentity,
  type HostInstallView,
} from "./package-host-state.js";
import type {
  BundleDescriptor,
  InstalledBundleEvidence,
  PackageAction,
  PackageCoordinates,
  PackageDeclaration,
  PackageHost,
  PackageSelection,
  PackageVersionEvidence,
} from "./package-model.js";
import { parsePortableInstallationMethod } from "./project-manifest.js";

/** A plan that cannot be derived safely fails closed with its reason. */
export class PackagePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagePlanError";
  }
}

/**
 * Everything one host grammar template may read. `source` and `installSpec` are
 * already host-facing: never a local mirror path. `marketplaceName` is the name
 * the host registers for the Source, resolved from host state or the snapshot.
 */
export interface StepTemplateInput {
  readonly descriptor: BundleDescriptor;
  readonly selection: PackageSelection;
  /** The unpinned install source, e.g. `git:github.com/owner/repo`. */
  readonly source: string;
  /** The install spec: `source`, pinned with `@<version>` when the selection is fixed. */
  readonly installSpec: string;
  /** The registered marketplace name, required once a Claude plan must name it. */
  readonly marketplaceName?: string;
  /** The host already knows this marketplace, so `add` is omitted. */
  readonly marketplaceKnown: boolean;
}

export type HostStepTemplate = (input: StepTemplateInput) => readonly (readonly string[])[];

export type HostStepTemplates = Readonly<Record<PackageHost, Readonly<Record<PackageAction, HostStepTemplate>>>>;

const NO_STEPS: readonly (readonly string[])[] = Object.freeze([]);

/**
 * The one place that knows each host CLI's grammar, verified against the
 * installed CLIs in `.scratch/packages/arena/host-cli-verbs.md`. V1 uses the
 * scoped verb for every action. Select and forget run nothing.
 */
export const HOST_STEP_TEMPLATES: HostStepTemplates = Object.freeze({
  pi: Object.freeze({
    install: (input: StepTemplateInput) => Object.freeze([
      Object.freeze(["pi", "install", input.installSpec]),
    ]),
    update: (input: StepTemplateInput) => Object.freeze([
      Object.freeze(["pi", "update", input.source]),
    ]),
    uninstall: (input: StepTemplateInput) => Object.freeze([
      Object.freeze(["pi", "remove", input.source]),
    ]),
    select: () => NO_STEPS,
    forget: () => NO_STEPS,
  }),
  claude: Object.freeze({
    install: (input: StepTemplateInput) => Object.freeze([
      ...(input.marketplaceKnown
        ? []
        : [Object.freeze(["claude", "plugin", "marketplace", "add", input.source])]),
      Object.freeze(["claude", "plugin", "install", claudeInstallId(input)]),
    ]),
    update: (input: StepTemplateInput) => Object.freeze([
      Object.freeze(["claude", "plugin", "marketplace", "update", claudeMarketplaceName(input)]),
      Object.freeze(["claude", "plugin", "update", claudeInstallId(input)]),
    ]),
    uninstall: (input: StepTemplateInput) => Object.freeze([
      Object.freeze(["claude", "plugin", "uninstall", claudeInstallId(input)]),
    ]),
    select: () => NO_STEPS,
    forget: () => NO_STEPS,
  }),
});

export interface HostPlanResolution {
  /**
   * The marketplace name declared in the Source's `.claude-plugin/marketplace.json`.
   * Required for Claude plans that must name a marketplace the host does not
   * already know; without it those plans fail closed rather than guess.
   */
  readonly marketplaceName?: string;
}

/**
 * The exact host argv for one action. Pure. Every produced argv is re-validated
 * through `parsePortableInstallationMethod`, so the recipe safety rules apply to
 * host commands too.
 *
 * The synthesized design's four arguments cannot carry the Claude marketplace
 * name, which lives in the Source snapshot's `marketplace.json` and never in the
 * host state before the first `marketplace add`. `resolution` supplies it; a
 * Claude plan that must name the marketplace and has no resolution fails closed.
 */
export function planHostSteps(
  action: PackageAction,
  descriptor: BundleDescriptor,
  selection: PackageSelection,
  state: HostInstallView,
  resolution: HostPlanResolution = {},
): readonly (readonly string[])[] {
  if (descriptor.host !== selection.host) {
    throw new PackagePlanError(
      `The bundle descriptor host ${JSON.stringify(descriptor.host)} does not match the selection host ${JSON.stringify(selection.host)}`,
    );
  }
  if (runsHostCommand(action) && !isInstallable(descriptor)) {
    throw new PackagePlanError(
      `The bundle ${JSON.stringify(descriptor.name)} is not installable (${descriptor.warnings.join("; ")})`,
    );
  }

  const source = hostSource(selection);
  const marketplace = descriptor.host === "claude" ? resolveClaudeMarketplace(state, selection) : undefined;
  const marketplaceName = resolution.marketplaceName ?? marketplace?.name;
  const input: StepTemplateInput = Object.freeze({
    descriptor,
    selection,
    source,
    installSpec: installSpec(source, selection),
    ...(marketplaceName === undefined ? {} : { marketplaceName }),
    marketplaceKnown: marketplace?.known === true,
  });

  const steps = HOST_STEP_TEMPLATES[descriptor.host][action](input);
  return Object.freeze(steps.map((argv, index) =>
    assertValidHostArgv(argv, `${descriptor.host} ${action} step ${index + 1}`),
  ));
}

/**
 * Every recorded coordinate an action may change. V1 uses the scoped verb for
 * every action, verified in `.scratch/packages/arena/host-cli-verbs.md`, so that
 * is the selection's own coordinates. Flip `HOST_WIDE_UPDATE` for a host when a
 * host-wide verb like `pi update --extensions` is chosen; this function then
 * returns every recorded coordinate of that host.
 */
export function affectedBy(
  action: PackageAction,
  selection: PackageSelection,
  recorded: readonly PackageSelection[],
): readonly PackageCoordinates[] {
  if (action === "update" && HOST_WIDE_UPDATE[selection.host]) {
    return Object.freeze(recorded
      .filter((candidate) => candidate.host === selection.host)
      .map((candidate) => coordinatesOf(candidate)));
  }
  return Object.freeze([coordinatesOf(selection)]);
}

const HOST_WIDE_UPDATE: Readonly<Record<PackageHost, boolean>> = Object.freeze({
  pi: false,
  claude: false,
});

/** sha256 over the canonical serialization of the declaration. Exact argv order included. */
export function packageApprovalDigest(declaration: PackageDeclaration): string {
  return createHash("sha256").update(canonicalJson(declaration), "utf8").digest("hex");
}

/**
 * Compares installed evidence with available evidence. Manifest versions compare
 * through `sameAppVersion` and `compareAppVersions`; commits compare by equality.
 * A mixed pair, missing evidence, or an opaque version is `unknown`, never `current`.
 */
export function classifyUpdate(
  installed: InstalledBundleEvidence,
  available: PackageVersionEvidence | undefined,
): "unknown" | "current" | "update available" {
  if (installed.kind !== "installed" || available === undefined) {
    return "unknown";
  }
  if (installed.version !== undefined && available.kind === "manifest-version") {
    if (sameAppVersion(installed.version, available.version)) {
      return "current";
    }
    const order = compareAppVersions(installed.version, available.version);
    if (order === undefined) {
      return "unknown";
    }
    return order < 0 ? "update available" : "current";
  }
  if (installed.commit !== undefined && available.kind === "git-commit") {
    return normalizeCommit(installed.commit) === normalizeCommit(available.commit)
      ? "current"
      : "update available";
  }
  return "unknown";
}

/** Validates one host argv with the shared portable-command rules. */
export function assertValidHostArgv(argv: readonly string[], label: string): readonly string[] {
  try {
    return parsePortableInstallationMethod({ kind: "command", argv }, { label }).argv;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the argv is not a portable no-shell command";
    throw new PackagePlanError(`Refused host command (${label}): ${reason}`);
  }
}

function claudeInstallId(input: StepTemplateInput): string {
  return `${claudePluginName(input)}@${claudeMarketplaceName(input)}`;
}

function claudePluginName(input: StepTemplateInput): string {
  return input.selection.host === "claude" ? input.selection.pluginName : input.descriptor.name;
}

function claudeMarketplaceName(input: StepTemplateInput): string {
  if (input.marketplaceName === undefined || input.marketplaceName === "") {
    throw new PackagePlanError(
      `Naming the marketplace for ${JSON.stringify(claudePluginName(input))} requires the name declared in the Source's .claude-plugin/marketplace.json`,
    );
  }
  return input.marketplaceName;
}

function resolveClaudeMarketplace(
  state: HostInstallView,
  selection: PackageSelection,
): { readonly name: string; readonly known: boolean } | undefined {
  if (selection.host !== "claude") {
    return undefined;
  }
  const known = claudeMarketplaceNamesForSource(state.claudeMarketplaces, selection.source)[0];
  if (known !== undefined) {
    return { name: known, known: true };
  }
  const installed = state.claudePlugins.records.find((record) =>
    !record.drifted && record.scope === "user" && record.pluginName === selection.pluginName && record.marketplace !== "");
  return installed === undefined ? undefined : { name: installed.marketplace, known: false };
}

function isInstallable(descriptor: BundleDescriptor): boolean {
  return !descriptor.warnings.some((warning) => warning.includes("not installable"));
}

function runsHostCommand(action: PackageAction): boolean {
  return action === "install" || action === "update" || action === "uninstall";
}

function hostSource(selection: PackageSelection): string {
  if (selection.host === "pi") {
    const identity = piSourceIdentity(selection.source);
    if (identity === undefined) {
      throw new PackagePlanError("Pi cannot install a built-in or local path Source");
    }
    return identity;
  }
  if (selection.source.kind === "builtin" || "path" in selection.source) {
    throw new PackagePlanError("Claude Code cannot install a built-in or local path Source");
  }
  return selection.source.url;
}

function installSpec(source: string, selection: PackageSelection): string {
  return selection.version.policy === "fixed" && selection.version.version !== ""
    ? `${source}@${selection.version.version}`
    : source;
}

function normalizeCommit(commit: string): string {
  return commit.trim().toLowerCase();
}

function coordinatesOf(selection: PackageSelection): PackageCoordinates {
  return selection.host === "pi"
    ? Object.freeze({ host: selection.host, root: selection.root })
    : Object.freeze({ host: selection.host, marketplaceRoot: selection.marketplaceRoot, pluginName: selection.pluginName });
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new PackagePlanError("The package declaration contains a value that cannot be canonicalized");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
