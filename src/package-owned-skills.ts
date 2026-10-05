import {
  bundleOwnedSkillMatcher,
  bundleOwnedSkillNameMatcher,
  discoverBundlesInSnapshot,
  type BundleOwnedSkillMatcher,
} from "./package-bundles.js";
import type { BundleDescriptor } from "./package-model.js";
import { sourceBundleScope } from "./package-content.js";
import { createSourceContentAccess, type SourceContentAccess } from "./skill-discovery.js";
import { createSourceOperations, type Source } from "./sources.js";

export interface PackageOwnedSkillOptions {
  /** The Sources whose bundles define ownership. Defaults to the registered Sources under `homeDirectory`. */
  readonly sources?: readonly Source[];
  readonly homeDirectory?: string;
  /** Reads one immutable Source view. Defaults to the Node Source content access. */
  readonly sourceContentAccess?: SourceContentAccess;
  readonly reportWarning?: (warning: string) => void;
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
 * pass discovery uses. A Source that cannot be listed or read warns and
 * contributes no exclusions, so an unresolvable Source never hides a Skill.
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
  const descriptors: BundleDescriptor[] = [];
  for (const source of sources) {
    try {
      descriptors.push(...discoverBundlesInSnapshot(await contentAccess.readSnapshot(source), sourceBundleScope(source)));
    } catch (error) {
      warn(`WARNING: Skipping Package-owned Skill exclusions for Source ${source.id}: ${errorMessage(error)}`);
    }
  }
  return packageOwnedSkillMatcher(descriptors);
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
