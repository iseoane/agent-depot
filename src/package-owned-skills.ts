import { homedir } from "node:os";

import {
  bundleOwnedSkillMatcher,
  bundleOwnedSkillNameMatcher,
  discoverBundlesInSnapshot,
  type BundleOwnedSkillMatcher,
} from "./package-bundles.js";
import { findInstalledBundle, readHostInstallView, type HostInstallView } from "./package-host-state.js";
import {
  packageSelectionFor,
  selectionKey,
  type BundleDescriptor,
  type PackageSelection,
} from "./package-model.js";
import { sourceBundleScope } from "./package-content.js";
import { defaultPackageStateDirectory, PackageStateStore } from "./package-state.js";
import type { ProjectSkillSelection, ProjectSource } from "./project-manifest.js";
import { createSourceContentAccess, type SourceContentAccess } from "./skill-discovery.js";
import { createSourceOperations, projectSourceOf, type Source } from "./sources.js";

export interface PackageOwnedSkillOptions {
  /** The Sources whose bundles define ownership. Defaults to the registered Sources under `homeDirectory`. */
  readonly sources?: readonly Source[];
  readonly homeDirectory?: string;
  /** Reads one immutable Source view. Defaults to the Node Source content access. */
  readonly sourceContentAccess?: SourceContentAccess;
  /** Recorded Package selections. Defaults to the state under `stateDirectory`. */
  readonly selections?: readonly PackageSelection[];
  /** Live host state. Defaults to the host files under `homeDirectory`. */
  readonly hostView?: HostInstallView;
  /** Where `packages.json` lives. Defaults to the user Package state directory. */
  readonly stateDirectory?: string;
  readonly reportWarning?: (warning: string) => void;
}

/** One discovered bundle bound to the Source it was discovered in. */
export interface DiscoveredBundle {
  readonly source: ProjectSource;
  readonly descriptor: BundleDescriptor;
}

/** Why a bundle is active: the user selected it, or a host state file proves it installed. */
export type PackageOwnershipReason = "selected" | "installed";

/** A bundle that owns its Skills, and the evidence that made it active. */
export interface ActiveBundle {
  readonly descriptor: BundleDescriptor;
  readonly reason: PackageOwnershipReason;
}

/**
 * The bundles that own their Skills. A bundle owns them only when it is active:
 * a recorded selection names the user's choice, or a host state file proves the
 * bundle installed. Source, host, and coordinates must all agree, and a bundle
 * that is not installable never owns. An unreadable host state is `unknown`, not
 * `installed`, so it never claims; the user's own selection still does.
 */
export function activeBundles(
  bundles: readonly DiscoveredBundle[],
  selections: readonly PackageSelection[],
  hostView: HostInstallView,
): readonly ActiveBundle[] {
  const selectedKeys = new Set(selections.map(selectionKey));
  const active: ActiveBundle[] = [];
  for (const { source, descriptor } of bundles) {
    if (!descriptor.installable) {
      continue;
    }
    const selection = packageSelectionFor(descriptor, source);
    if (selectedKeys.has(selectionKey(selection))) {
      active.push({ descriptor, reason: "selected" });
      continue;
    }
    if (findInstalledBundle(hostView, descriptor, selection).kind === "installed") {
      active.push({ descriptor, reason: "installed" });
    }
  }
  return Object.freeze(active);
}

/**
 * Composes ownership for descriptors a caller already derived from the snapshot
 * pass that fed skill discovery, so no second walk or hand-synced list is
 * needed. A Skill path matches a `skill-category` component; a bare directory
 * name matches a Skill name that component declares.
 */
export function packageOwnedSkillMatcher(
  descriptors: readonly BundleDescriptor[],
): BundleOwnedSkillMatcher {
  const byPath = bundleOwnedSkillMatcher(descriptors);
  const byName = bundleOwnedSkillNameMatcher(descriptors);
  return (skillPath: string): BundleDescriptor | undefined =>
    byPath(skillPath) ?? (skillPath.includes("/") ? undefined : byName(skillPath));
}

/**
 * Reads one snapshot per Source and derives bundle ownership from the same
 * pass discovery uses, then keeps only the bundles the user selected or a host
 * proves installed. A Source or Package state that cannot be read warns and
 * contributes no exclusions, so an unresolvable input never hides a Skill and a
 * missing record never falsely claims one.
 */
export async function loadPackageOwnedSkillFilter(
  options: PackageOwnedSkillOptions = {},
): Promise<BundleOwnedSkillMatcher> {
  const warn = options.reportWarning ?? (warning => process.emitWarning(warning));
  let sources: readonly Source[];
  try {
    sources = options.sources ?? await createSourceOperations({
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    }).listSources();
  } catch (error) {
    warn(`WARNING: Package-owned Skill exclusions unavailable; no exclusions applied: ${errorMessage(error)}`);
    return () => undefined;
  }

  const contentAccess = options.sourceContentAccess ?? createSourceContentAccess();
  const bundles: DiscoveredBundle[] = [];
  for (const source of sources) {
    try {
      const projectSource = projectSourceOf(source);
      for (const descriptor of discoverBundlesInSnapshot(await contentAccess.readSnapshot(source), sourceBundleScope(source))) {
        bundles.push({ source: projectSource, descriptor });
      }
    } catch (error) {
      warn(`WARNING: Skipping Package-owned Skill exclusions for Source ${source.id}: ${errorMessage(error)}`);
    }
  }

  return packageOwnedSkillMatcher(activeBundles(bundles, await loadSelections(options, warn), await loadHostView(options)).map(bundle => bundle.descriptor));
}

async function loadSelections(
  options: PackageOwnedSkillOptions,
  warn: (warning: string) => void,
): Promise<readonly PackageSelection[]> {
  if (options.selections !== undefined) {
    return options.selections;
  }
  try {
    const records = await new PackageStateStore(
      options.stateDirectory ?? defaultPackageStateDirectory(process.env, process.platform, options.homeDirectory ?? homedir()),
    ).list();
    return records.map(record => record.selection);
  } catch (error) {
    warn(`WARNING: Package selection state unavailable; no Package-owned Skill exclusions applied: ${errorMessage(error)}`);
    return [];
  }
}

async function loadHostView(options: PackageOwnedSkillOptions): Promise<HostInstallView> {
  return options.hostView ?? await readHostInstallView({
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  });
}

/**
 * The recorded portable user-global installations a bundle's own
 * `skill-category` components would duplicate, matched by Source and by
 * Source-relative Skill path or bare Skill name. Empty when nothing overlaps.
 * A caller refuses the Package lifecycle on any conflict instead of silently
 * replacing or removing the portable copy.
 */
export function portableSkillConflicts(
  descriptor: BundleDescriptor,
  source: ProjectSource,
  installations: readonly ProjectSkillSelection[],
): readonly ProjectSkillSelection[] {
  const owned = packageOwnedSkillMatcher([descriptor]);
  return Object.freeze(installations.filter((installation) =>
    sameSource(installation.source, source) && owned(installation.path) !== undefined,
  ));
}

function sameSource(left: ProjectSource, right: ProjectSource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Refuses a bundle-owned Skill path or name, naming the Package and its Host. */
export function assertSkillNotPackageOwned(skillPath: string, owned: BundleOwnedSkillMatcher): void {
  const owner = owned(skillPath);
  if (owner === undefined) {
    return;
  }
  throw new Error(
    `Package-owned Skill ${JSON.stringify(skillPath)} is provided by the ${owner.host} Package ${JSON.stringify(owner.name)}; ` +
    "it cannot be installed, adopted, or removed as a loose Skill, and no path was changed",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
