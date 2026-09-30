import path from "node:path";

import {
  addProjectSkillHosts,
  inspectProjectSkillHostAddition,
  inspectProjectSkillRemoval,
  removeProjectSkill,
  type ProjectInstallationOptions,
  type ProjectSkillHostAdditionInspection,
  type ProjectSkillRemovalInspection,
} from "./project-installation.js";
import type { ProjectHost, ProjectSkillSelection } from "./project-manifest.js";
import {
  assertManagedInstallationRecordsUnchanged,
  assertRemovalInspectionUnchanged,
  executeSkillRemoval,
  planSkillRemoval,
  SkillSelectionError,
  type SkillRemovalPlan,
} from "./skill-removal.js";
import type { SourceOperations } from "./sources.js";

/**
 * Shared flow for changing which Hosts a recorded user-global Skill serves:
 * plan (inspect + preview), then execute (recheck + change + reconcile record).
 * Non-Claude Hosts share the canonical `.agents/skills/<name>` location and
 * Claude is a symlink to it, so only the Claude location is ever created or
 * deleted by a Host change; the canonical files go away only on full removal.
 */

/** Operations needed to change Hosts and reconcile the installation record. */
export type SkillHostOperations = Pick<
  SourceOperations,
  "listUserGlobalInstallations" | "updateUserGlobalInstallation" | "removeUserGlobalInstallations"
>;

export interface HostAdditionPlan {
  readonly selection: ProjectSkillSelection;
  readonly hosts: readonly ProjectHost[];
  /** The record as it will be persisted, with the new Hosts appended. */
  readonly updated: ProjectSkillSelection;
  readonly inspection: ProjectSkillHostAdditionInspection;
  readonly preview: readonly string[];
}

export type HostRemovalPlan =
  | { readonly kind: "full"; readonly plan: SkillRemovalPlan & { readonly preview: readonly string[] } }
  | {
      readonly kind: "hosts";
      readonly selection: ProjectSkillSelection;
      readonly removed: readonly ProjectHost[];
      readonly remaining: readonly ProjectHost[];
      readonly inspection: ProjectSkillRemovalInspection;
      /** Locations deleted for the removed Hosts; never a location a remaining Host uses. */
      readonly deletePaths: readonly string[];
      readonly preview: readonly string[];
    };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueHosts(hosts: readonly ProjectHost[], verb: string): readonly ProjectHost[] {
  const unique = [...new Set(hosts)];
  if (unique.length === 0) throw new SkillSelectionError(`Name at least one Host to ${verb}`);
  return unique;
}

/** Plan step: validates the Hosts, inspects the installation and previews the new locations. */
export async function planHostAddition(
  selection: ProjectSkillSelection,
  hosts: readonly ProjectHost[],
  options: ProjectInstallationOptions,
): Promise<HostAdditionPlan> {
  const added = uniqueHosts(hosts, "add");
  const present = added.filter((host) => selection.hosts.includes(host));
  if (present.length > 0) {
    throw new SkillSelectionError(`Skill ${JSON.stringify(selection.path)} is already exposed to ${present.join(", ")}`);
  }
  const inspection = await inspectProjectSkillHostAddition(selection, added, options);
  const preview = [`  add hosts ${added.join(", ")} to ${JSON.stringify(selection.path)} (installed content and version are unchanged)`];
  for (const location of inspection.createPaths) {
    preview.push(`    create ${location} as a symlink to ${inspection.canonicalPath}`);
  }
  if (inspection.createPaths.length === 0) {
    preview.push(`    no files change: ${inspection.canonicalPath} already serves these hosts`);
  }
  preview.push("    ADDITIONAL HOST EXPOSURE: this exposes the installed Skill to more hosts and needs explicit confirmation");
  const updated = { ...selection, hosts: [...selection.hosts, ...added] };
  return { selection, hosts: added, updated, inspection, preview };
}

/** Execute step: needs the additional-host confirmation, creates the locations, then updates the record. */
export async function executeHostAddition(
  plan: HostAdditionPlan,
  operations: SkillHostOperations,
  options: ProjectInstallationOptions,
  initialManaged: readonly ProjectSkillSelection[],
  confirmAdditionalHostExposure: boolean,
): Promise<void> {
  if (!confirmAdditionalHostExposure) {
    throw new Error("Adding a Host is an additional Host exposure and needs explicit confirmation; no path was changed");
  }
  const { listUserGlobalInstallations: list, updateUserGlobalInstallation: update } = operations;
  if (!list || !update) throw new Error("Configured Source operations cannot update user-global Skills");
  assertManagedInstallationRecordsUnchanged(initialManaged, await list.call(operations));
  const transaction = await addProjectSkillHosts(plan.selection, plan.hosts, plan.inspection, options);
  try {
    await update.call(operations, plan.updated);
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Updating the installation record failed (${describe(error)}) and rolling back the new Host locations also failed (${describe(rollbackError)}); check the Claude location by hand`,
      );
    }
    throw error;
  }
}

/** Plan step: removing every recorded Host is a full removal; otherwise only the removed Hosts' own locations go. */
export async function planHostRemoval(
  selection: ProjectSkillSelection,
  hosts: readonly ProjectHost[],
  options: ProjectInstallationOptions,
): Promise<HostRemovalPlan> {
  const removed = uniqueHosts(hosts, "remove");
  const unknown = removed.filter((host) => !selection.hosts.includes(host));
  if (unknown.length > 0) {
    throw new SkillSelectionError(`Host ${unknown.join(", ")} is not recorded for this Skill; recorded hosts: ${selection.hosts.join(", ")}`);
  }
  const remaining = selection.hosts.filter((host) => !removed.includes(host));
  if (remaining.length === 0) {
    return { kind: "full", plan: await planSkillRemoval([selection], options) };
  }
  const inspection = await inspectProjectSkillRemoval(selection, options);
  const claudePath = path.join(path.resolve(options.projectRoot), ".claude", "skills", inspection.skillName);
  const canonicalPath = path.join(path.resolve(options.projectRoot), ".agents", "skills", inspection.skillName);
  if (removed.includes("claude") && inspection.paths[0] === claudePath) {
    throw new SkillSelectionError(
      `Cannot remove Host claude: ${claudePath} is the only copy of this Skill and the remaining hosts (${remaining.join(", ")}) need it; remove the whole Skill instead`,
    );
  }
  const deletePaths = removed.includes("claude") && inspection.paths.includes(claudePath) ? [claudePath] : [];
  const preview = [`  remove hosts ${removed.join(", ")} from ${JSON.stringify(selection.path)}; remaining hosts: ${remaining.join(", ")}`];
  if (deletePaths.length > 0) {
    preview.push(`    delete ${claudePath} (managed Claude symlink)`, `    keep ${canonicalPath} (serves the remaining hosts)`);
  } else {
    preview.push(`    no files are deleted: ${inspection.paths[0]} is kept for the remaining hosts`);
  }
  return { kind: "hosts", selection, removed, remaining, inspection, deletePaths, preview };
}

/** Execute step: rechecks, deletes only the removed Hosts' locations, then updates the record. */
export async function executeHostRemoval(
  plan: HostRemovalPlan,
  operations: SkillHostOperations,
  options: ProjectInstallationOptions,
  initialManaged: readonly ProjectSkillSelection[],
): Promise<void> {
  if (plan.kind === "full") {
    await executeSkillRemoval(plan.plan, operations, options, initialManaged);
    return;
  }
  const { listUserGlobalInstallations: list, updateUserGlobalInstallation: update } = operations;
  if (!list || !update) throw new Error("Configured Source operations cannot update user-global Skills");
  assertRemovalInspectionUnchanged(plan.inspection, await inspectProjectSkillRemoval(plan.selection, options));
  assertManagedInstallationRecordsUnchanged(initialManaged, await list.call(operations));
  await removeProjectSkill(plan.selection, plan.inspection, options, plan.deletePaths);
  try {
    await update.call(operations, { ...plan.selection, hosts: plan.remaining });
  } catch (error) {
    if (plan.deletePaths.length === 0) throw error;
    throw new Error(
      `Deleted ${plan.deletePaths.join(", ")} but the installation record was not updated (${describe(error)}); the record still lists ${plan.removed.join(", ")}. ` +
        `Rerun \`agent-depot skill remove ${JSON.stringify(plan.selection.path)} --host ${plan.removed.join(" --host ")}\` to reconcile the record; the missing location is tolerated.`,
      { cause: error },
    );
  }
}
