import {
  assertNoOverlappingProjectSkillRemovalTargets,
  inspectAbsentManagedSkillRecord,
  inspectProjectSkillRemoval,
  ProjectInstallationError,
  removeProjectSkill,
  type ProjectInstallationOptions,
  type ProjectSkillRemovalInspection,
} from "./project-installation.js";
import type { ProjectSkillSelection } from "./project-manifest.js";
import type { SourceOperations } from "./sources.js";

/**
 * Shared removal flow for user-global managed Skills: inspect, preview,
 * recheck, delete files, reconcile installation records. User-global only;
 * it never reads project manifests and never touches Source caches.
 */

/** Inspection of a batch of selected user-global Skills, in selection order. */
export interface SkillRemovalPlan {
  readonly selections: readonly ProjectSkillSelection[];
  readonly inspections: readonly ProjectSkillRemovalInspection[];
}

/** Operations needed to remove a user-global Skill and reconcile its record. */
export type SkillRemovalOperations = Pick<SourceOperations, "listUserGlobalInstallations" | "removeUserGlobalInstallations">;

/** Result of resolving a user-supplied `<id|path>` against managed installations. */
export class SkillSelectionError extends Error {}

/** Resolves ids (exact path or unique final path segment) to managed installations. */
export function selectUserGlobalSkills(
  installations: readonly ProjectSkillSelection[],
  requested: readonly string[],
): readonly ProjectSkillSelection[] {
  const selected: ProjectSkillSelection[] = [];
  for (const value of requested) {
    const exact = installations.filter((selection) => selection.path === value);
    const named = installations.filter((selection) => selection.path.split("/").at(-1) === value);
    const matches = exact.length > 0 ? exact : named;
    if (matches.length > 1) {
      throw new SkillSelectionError(`Ambiguous user-global Skill ${JSON.stringify(value)}; use one of: ${matches.map((selection) => selection.path).join(", ")}`);
    }
    const candidate = matches[0];
    if (!candidate) {
      throw new SkillSelectionError(`Unknown user-global Skill ${JSON.stringify(value)}`);
    }
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return Object.freeze(selected);
}

/** Builds the options used to inspect and remove user-global Skills under a home directory. */
export function userGlobalRemovalOptions(
  homeDirectory: string,
  overrides?: Omit<ProjectInstallationOptions, "projectRoot" | "sourceAccess">,
): ProjectInstallationOptions {
  return {
    projectRoot: homeDirectory,
    sourceAccess: { readSkillTree: async () => [] },
    installationTrust: "user-global-state",
    ...overrides,
  };
}

/** Preview lines for one inspected removal, including adopted/modified warnings. */
export function describeSkillRemoval(
  selection: ProjectSkillSelection,
  inspection: ProjectSkillRemovalInspection,
  label: string,
): readonly string[] {
  const lines = inspection.recordOnly
    ? [`  forget missing installation record for ${label}${JSON.stringify(selection.path)} (record only; no files removed)`]
    : [`  remove ${label}${JSON.stringify(selection.path)} at ${inspection.paths.join(", ")}`];
  if (!inspection.recordOnly && inspection.adopted) {
    lines.push("    WARNING: this Skill was adopted; removal deletes content that Agent Depot did not create");
  }
  if (!inspection.recordOnly && inspection.modified) {
    lines.push("    WARNING: this Skill is locally modified or has no trusted baseline; removal deletes those changes");
  }
  return lines;
}

/**
 * Inspects every selection in order. `onInspected` lets callers stream preview
 * lines while inspecting, so an inspection failure keeps earlier output.
 */
export async function inspectSkillRemovals(
  selections: readonly ProjectSkillSelection[],
  options: ProjectInstallationOptions,
  onInspected?: (selection: ProjectSkillSelection, inspection: ProjectSkillRemovalInspection) => void,
): Promise<SkillRemovalPlan> {
  const inspections: ProjectSkillRemovalInspection[] = [];
  for (const selection of selections) {
    const otherInstallationPaths = [
      ...(options.otherInstallationPaths ?? []),
      ...selections.filter((candidate) => candidate !== selection)
        .flatMap((candidate) => candidate.installation ? [candidate.installation.path] : []),
    ];
    let inspection: ProjectSkillRemovalInspection;
    try {
      inspection = await inspectProjectSkillRemoval(selection, { ...options, otherInstallationPaths });
    } catch (error) {
      if (!(error instanceof ProjectInstallationError) || error.code !== "missing-installation" || options.installationTrust !== "user-global-state") throw error;
      inspection = await inspectAbsentManagedSkillRecord(selection, { ...options, otherInstallationPaths });
    }
    inspections.push(inspection);
    onInspected?.(selection, inspection);
  }
  return { selections, inspections };
}

/** Plan step: inspect, reject overlapping targets, and return preview lines. */
export async function planSkillRemoval(
  selections: readonly ProjectSkillSelection[],
  options: ProjectInstallationOptions,
  label = "",
): Promise<SkillRemovalPlan & { readonly preview: readonly string[] }> {
  const preview: string[] = [];
  const plan = await inspectSkillRemovals(selections, options, (selection, inspection) => {
    preview.push(...describeSkillRemoval(selection, inspection, label));
  });
  assertNoOverlappingProjectSkillRemovalTargets(plan.inspections);
  return { ...plan, preview };
}

/** Re-inspects every target before the first deletion so a batch is never partially removed. */
export async function recheckSkillRemoval(
  plan: SkillRemovalPlan,
  options: ProjectInstallationOptions,
): Promise<SkillRemovalPlan> {
  const rechecked = await inspectSkillRemovals(plan.selections, options);
  assertNoOverlappingProjectSkillRemovalTargets(rechecked.inspections);
  return rechecked;
}

export function assertRemovalInspectionUnchanged(before: ProjectSkillRemovalInspection, after: ProjectSkillRemovalInspection): void {
  const unchanged = before.digest === after.digest && before.recordOnly === after.recordOnly && before.adopted === after.adopted && before.modified === after.modified &&
    before.skillName === after.skillName && before.nonCanonicalPath === after.nonCanonicalPath &&
    before.paths.length === after.paths.length && before.paths.every((candidate, pathIndex) => candidate === after.paths[pathIndex]);
  if (!unchanged) {
    throw new Error("The inspected Skill removal target changed before deletion; no path was removed");
  }
}

export function assertManagedInstallationRecordsUnchanged(
  expected: readonly ProjectSkillSelection[],
  actual: readonly ProjectSkillSelection[],
): void {
  const expectedKey = expected.map((selection) => JSON.stringify(selection)).sort().join("\n");
  const actualKey = actual.map((selection) => JSON.stringify(selection)).sort().join("\n");
  if (expectedKey !== actualKey) {
    throw new Error("Managed Skill installation records changed before deletion; no path was removed");
  }
}

/** Deletes the files of every rechecked selection; records are left to the caller. */
export async function removeSkillFiles(
  plan: SkillRemovalPlan,
  rechecked: SkillRemovalPlan,
  options: ProjectInstallationOptions,
): Promise<void> {
  assertRemovalBatchUnchanged(plan, rechecked);
  for (const [index, selection] of plan.selections.entries()) {
    assertRemovalInspectionUnchanged(plan.inspections[index]!, rechecked.inspections[index]!);
    if (rechecked.inspections[index]!.recordOnly) continue;
    await removeProjectSkill(selection, rechecked.inspections[index]!, options);
  }
}

/**
 * Removes each Skill's files, then its installation record, verifying the
 * managed records are unchanged before each deletion. Returns the reconciled
 * records so callers can continue with further checks.
 */
export async function removeSkillsAndRecords(
  plan: SkillRemovalPlan,
  rechecked: SkillRemovalPlan,
  operations: SkillRemovalOperations,
  options: ProjectInstallationOptions,
  initialManaged: readonly ProjectSkillSelection[],
): Promise<readonly ProjectSkillSelection[]> {
  const list = operations.listUserGlobalInstallations;
  const reconcile = operations.removeUserGlobalInstallations;
  if (!list || !reconcile) {
    throw new Error("Configured Source operations cannot reconcile removed user-global Skills");
  }
  assertRemovalBatchUnchanged(plan, rechecked);
  let expected = initialManaged;
  for (const [index, selection] of plan.selections.entries()) {
    assertRemovalInspectionUnchanged(plan.inspections[index]!, rechecked.inspections[index]!);
    assertManagedInstallationRecordsUnchanged(expected, await list.call(operations));
    if (rechecked.inspections[index]!.recordOnly) {
      const latest = await inspectAbsentManagedSkillRecord(selection, options);
      assertRemovalInspectionUnchanged(rechecked.inspections[index]!, latest);
    } else {
      await removeProjectSkill(selection, rechecked.inspections[index]!, options);
    }
    await reconcile.call(operations, [selection]);
    expected = await list.call(operations);
  }
  return expected;
}

/** Compare the complete confirmed batch before any entry can mutate files or records. */
function assertRemovalBatchUnchanged(plan: SkillRemovalPlan, rechecked: SkillRemovalPlan): void {
  if (plan.selections.length !== rechecked.selections.length || plan.inspections.length !== rechecked.inspections.length) {
    throw new Error("The inspected Skill removal batch changed before deletion; no path was removed");
  }
  for (const [index, inspection] of plan.inspections.entries()) {
    const current = rechecked.inspections[index];
    if (!current) throw new Error("The inspected Skill removal batch changed before deletion; no path was removed");
    assertRemovalInspectionUnchanged(inspection, current);
  }
}

/** Execute step: recheck, then remove files and records. */
export async function executeSkillRemoval(
  plan: SkillRemovalPlan,
  operations: SkillRemovalOperations,
  options: ProjectInstallationOptions,
  initialManaged: readonly ProjectSkillSelection[],
): Promise<readonly ProjectSkillSelection[]> {
  const rechecked = await recheckSkillRemoval(plan, options);
  return removeSkillsAndRecords(plan, rechecked, operations, options, initialManaged);
}
