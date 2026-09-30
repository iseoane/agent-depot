import type { ProjectSkillSelection } from "./project-manifest.js";
import { assertManagedInstallationRecordsUnchanged } from "./skill-removal.js";
import type { SourceOperations } from "./sources.js";
import {
  inspectUserGlobalSkillRemoval,
  removeUserGlobalSkill,
  removeUserGlobalSymlink,
  type UserGlobalSkillRemovalInspection,
  type UserGlobalSymlinkRemovalInspection,
} from "./user-global-skill-inventory.js";

/** The preview lines the CLI prints under each exact unmanaged path it will delete. */
export function describeUnmanagedRemoval(inspection: UserGlobalSkillRemovalInspection): readonly string[] {
  return [
    `  remove exact path ${JSON.stringify(inspection.path)}`,
    "    WARNING: this is a permanent deletion; Agent Depot will not retain a backup",
    "    WARNING: recovery through Agent Depot requires a resolvable Source and is not guaranteed",
  ];
}

/** Preview lines for a symbolic link: only the link is removed, never what it points to. */
export function describeUnmanagedSymlinkRemoval(inspection: UserGlobalSymlinkRemovalInspection): readonly string[] {
  return [
    `  remove symbolic link ${JSON.stringify(inspection.path)} -> ${JSON.stringify(inspection.target)}`,
    "    only the link is removed; the path it points to is kept",
  ];
}

export interface UnmanagedRemovalContext {
  readonly operations: SourceOperations;
  readonly homeDirectory: string;
}

/** Rechecks the records and the inspected tree, then permanently deletes one unmanaged Skill directory. */
export async function removeInspectedUnmanagedSkill(
  context: UnmanagedRemovalContext,
  inspection: UserGlobalSkillRemovalInspection,
  expectedManagedInstallations: readonly ProjectSkillSelection[],
): Promise<void> {
  const { operations, homeDirectory } = context;
  const latestManagedInstallations = await operations.listUserGlobalInstallations!();
  assertManagedInstallationRecordsUnchanged(expectedManagedInstallations, latestManagedInstallations);
  const latestInspection = await inspectUserGlobalSkillRemoval(inspection.path, {
    homeDirectory,
    managedInstallations: latestManagedInstallations,
  });
  assertUnmanagedInspectionUnchanged(inspection, latestInspection);
  await removeUserGlobalSkill(inspection, {
    homeDirectory,
    managedInstallations: latestManagedInstallations,
    readManagedInstallations: async () => operations.listUserGlobalInstallations!(),
    expectedManagedInstallations,
  });
}

/** Rechecks the records and the inspected link, then unlinks only the link. */
export async function removeInspectedUnmanagedSymlink(
  context: UnmanagedRemovalContext,
  inspection: UserGlobalSymlinkRemovalInspection,
  expectedManagedInstallations: readonly ProjectSkillSelection[],
): Promise<void> {
  const { operations, homeDirectory } = context;
  const latestManagedInstallations = await operations.listUserGlobalInstallations!();
  assertManagedInstallationRecordsUnchanged(expectedManagedInstallations, latestManagedInstallations);
  await removeUserGlobalSymlink(inspection, {
    homeDirectory,
    managedInstallations: latestManagedInstallations,
    readManagedInstallations: async () => operations.listUserGlobalInstallations!(),
    expectedManagedInstallations,
  });
}

/** Removes the inspected unmanaged Skills in order; the first failure stops the run, as in the CLI. */
export async function removeInspectedUnmanagedSkills(
  context: UnmanagedRemovalContext,
  inspections: readonly UserGlobalSkillRemovalInspection[],
  expectedManagedInstallations: readonly ProjectSkillSelection[],
): Promise<void> {
  for (const inspection of inspections) {
    await removeInspectedUnmanagedSkill(context, inspection, expectedManagedInstallations);
  }
}

function assertUnmanagedInspectionUnchanged(
  expected: UserGlobalSkillRemovalInspection,
  actual: UserGlobalSkillRemovalInspection,
): void {
  if (expected.name !== actual.name || expected.path !== actual.path || expected.identity !== actual.identity || expected.digest !== actual.digest) {
    throw new Error(`The inspected unmanaged Skill changed before deletion: ${JSON.stringify(expected.path)}; no path was changed`);
  }
}
