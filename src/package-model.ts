import type { ProjectHost, ProjectSource, VersionPolicy } from "./project-manifest.js";

/** V1 bundle hosts. Codex and OpenCode packaging stays recognized but deferred. */
export const PACKAGE_HOSTS = Object.freeze(["pi", "claude"] as const satisfies readonly ProjectHost[]);
export type PackageHost = (typeof PACKAGE_HOSTS)[number];

/** Where a bundle is. Stable while its manifest changes, so a rename is drift, not identity. */
export type PackageCoordinates =
  | { readonly host: "pi"; readonly root: string }
  | { readonly host: "claude"; readonly marketplaceRoot: string; readonly pluginName: string };

export type PackageSelection = PackageCoordinates & {
  readonly source: ProjectSource;
  readonly version: VersionPolicy;
};

/** Modeled for a later wave. V1 ships only the `git` and `marketplace` kinds. */
export type PackageSourceKind =
  | { readonly kind: "git"; readonly url: string; readonly ref?: string }
  | { readonly kind: "marketplace"; readonly url: string; readonly plugin: string }
  | { readonly kind: "npm"; readonly package: string; readonly version?: string };

export type PackageComponentKind =
  | "skills" | "extensions" | "prompts" | "themes"
  | "agents" | "commands" | "hooks" | "mcp-servers" | "lsp-servers"
  | "output-styles" | "workflows" | "monitors";

/** Who owns a component once the host CLI has it. */
export type PackageComponentOwnership = "skill-category" | "host-only";

/** What the host does with it. Drives the risk line in the preview. */
export type PackageComponentEffect = "executable" | "instruction" | "data";

export interface PackageComponent {
  readonly kind: PackageComponentKind;
  readonly ownership: PackageComponentOwnership;
  readonly effect: PackageComponentEffect;
  readonly paths: readonly string[];
  readonly skillNames?: readonly string[];
}

/** The single list of categories Agent Depot reports but never manages. */
export const DEFERRED_COMPONENT_KINDS = Object.freeze(["agents", "mcp-servers"] as const);

export interface BundleDescriptor {
  readonly host: PackageHost;
  readonly coordinates: PackageCoordinates;
  readonly name: string;
  readonly version?: PackageVersionEvidence;
  readonly components: readonly PackageComponent[];
  readonly warnings: readonly string[];
  /** Keys the approval receipt. sha256 over the bundle's raw manifest bytes, sorted by path. */
  readonly manifestDigest: string;
}

/** A version Agent Depot can state about the available bundle. */
export type PackageVersionEvidence =
  | { readonly kind: "manifest-version"; readonly version: string; readonly declaredBy: "bundle" | "marketplace-entry" }
  | { readonly kind: "git-commit"; readonly commit: string };

/** What the host reports about an install. Read-only evidence, never written. */
export type InstalledBundleEvidence =
  | { readonly kind: "installed"; readonly version?: string; readonly commit?: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/** What Agent Depot owns. The presence of the record is the selection, not the install. */
export interface InstalledPackage {
  readonly selection: PackageSelection;
  readonly installId: string;
  readonly lastDelegatedCommit?: string;
  readonly verified?: PackageVersionEvidence;
  readonly verifiedAt: string;
}

export interface PersistedPackageState {
  readonly version: 1;
  readonly packages: readonly InstalledPackage[];
}

export interface PackageInspection {
  readonly descriptor?: BundleDescriptor;
  readonly installed: InstalledBundleEvidence;
  readonly available?: PackageVersionEvidence;
  readonly approval: "approved" | "needs approval";
  readonly drift?: string;
}

export interface PackageCommand {
  readonly purpose: "register" | "apply" | "remove";
  readonly executable: string;
  readonly resolvedPath?: string;
  readonly args: readonly string[];
  readonly summary: string;
}

export interface PackagePlanOrigin {
  readonly manifestDigest: string;
  readonly installId: string;
  readonly resolvedCommit?: string;
}

export interface PackageLifecyclePlan {
  readonly selection: PackageSelection;
  readonly action: PackageAction;
  readonly descriptor: BundleDescriptor;
  readonly commands: readonly PackageCommand[];
  /** Every recorded coordinate this action may change. Pi update is host-wide. */
  readonly affects: readonly PackageCoordinates[];
  readonly warnings: readonly string[];
  readonly cwd: string;
  readonly environment: string;
  readonly origin: PackagePlanOrigin;
  /** Host state already satisfies the action. The plan runs nothing. */
  readonly skipExecution?: boolean;
}

export type PackageAction = "install" | "update" | "uninstall" | "select" | "forget";

export type PackageLifecycleResult =
  | { readonly status: "installed"; readonly verified: InstalledBundleEvidence }
  | { readonly status: "updated"; readonly previous: InstalledBundleEvidence; readonly verified: InstalledBundleEvidence }
  | { readonly status: "removed" }
  | { readonly status: "selected" }
  | { readonly status: "forgotten" }
  | { readonly status: "not confirmed" }
  | { readonly status: "stale plan"; readonly reason: string }
  | { readonly status: "manual required"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly output?: string };

export interface PackageUpdateCheck {
  readonly installed: InstalledPackage;
  readonly status: "unknown" | "current" | "update available";
  readonly available?: PackageVersionEvidence;
  readonly reason?: string;
}

/** What the receipt covers. Digest = sha256 of a canonical JSON serialization. */
export interface PackageDeclaration {
  readonly sourceUrl: string;
  readonly ref?: string;
  readonly coordinates: PackageCoordinates;
  readonly manifestDigest: string;
  readonly argv: readonly (readonly string[])[];
}

/** A host install token that has already passed a host-identity validator. */
export type HostInstallSpec = string & { readonly __hostInstallSpec: unique symbol };

/** The POSIX directory identifying where a bundle lives within its Source. */
export function bundleRoot(coordinates: PackageCoordinates): string {
  return coordinates.host === "pi" ? coordinates.root : coordinates.marketplaceRoot;
}

/** A human-readable one-line label for a bundle's coordinates. */
export function describeCoordinates(coordinates: PackageCoordinates): string {
  const at = (pathValue: string): string => (pathValue === "" ? "." : pathValue);
  return coordinates.host === "pi"
    ? `pi ${at(coordinates.root)}`
    : `claude ${coordinates.pluginName}@${at(coordinates.marketplaceRoot)}`;
}

/**
 * The stable selection identity. Derived from the Source and the coordinates
 * only, so a bundle rename (its manifest name or version) does not move the
 * key, while a Source or coordinate change does.
 */
export function selectionKey(selection: PackageSelection): string {
  const coordinates: PackageCoordinates = selection.host === "pi"
    ? { host: selection.host, root: selection.root }
    : { host: selection.host, marketplaceRoot: selection.marketplaceRoot, pluginName: selection.pluginName };
  return JSON.stringify([selection.source, coordinates]);
}
