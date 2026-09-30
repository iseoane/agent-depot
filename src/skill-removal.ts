import {
  assertNoOverlappingProjectSkillRemovalTargets,
  inspectProjectSkillRemoval,
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
    const exact = installations.find((selection) => selection.path === value);
    const named = installations.filter((selection) => selection.path.split("/").at(-1) === value);
    if (!exact && named.length > 1) {
      throw new SkillSelectionError(`Ambiguous user-global Skill ${JSON.stringify(value)}; use one of: ${named.map((selection) => selection.path).join(", ")}`);
    }
    const candidate = exact ?? named[0];
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
  const lines = [`  remove ${label}${JSON.stringify(selection.path)} at ${inspection.paths.join(", ")}`];
  if (inspection.adopted) {
    lines.push("    WARNING: this Skill was adopted; removal deletes content that Agent Depot did not create");
  }
  if (inspection.modified) {
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
    const inspection = await inspectProjectSkillRemoval(selection, options);
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
  const unchanged = before.digest === after.digest && before.adopted === after.adopted && before.modified === after.modified &&
    before.skillName === after.skillName && before.paths.length === after.paths.length &&
    before.paths.every((candidate, pathIndex) => candidate === after.paths[pathIndex]);
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
  for (const [index, selection] of plan.selections.entries()) {
    assertRemovalInspectionUnchanged(plan.inspections[index]!, rechecked.inspections[index]!);
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
  let expected = initialManaged;
  for (const [index, selection] of plan.selections.entries()) {
    assertRemovalInspectionUnchanged(plan.inspections[index]!, rechecked.inspections[index]!);
    assertManagedInstallationRecordsUnchanged(expected, await list.call(operations));
    await removeProjectSkill(selection, rechecked.inspections[index]!, options);
    await reconcile.call(operations, [selection]);
    expected = await list.call(operations);
  }
  return expected;
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
