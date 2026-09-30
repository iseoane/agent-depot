#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createSourceContentAccess, skillTreeBaseline, type SkillCandidate, type SkillTreeFile } from "./skill-discovery.js";
import {
  BuiltInSourceError,
  createSourceOperations,
  executeSourceInstallationMethod,
  parseSourceInstallationMethod,
  resolveProjectSource,
  SourceMetadataError,
  SourceNotFoundError,
  type Source,
  type SourceInstallationMethod,
  type SourceOperations,
  type UserGlobalSkillMigration,
} from "./sources.js";
import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  PROJECT_HOSTS,
  type ProjectHost,
  type ProjectManifest,
  type ProjectSkillSelection,
  type ProjectSource,
  type ResolvedVersionEvidence,
  type VersionPolicy,
} from "./project-manifest.js";
import {
  inspectProjectSkillInstallation,
  inspectProjectSkillRemoval,
  installProjectSkillTransaction,
  removeProjectSkill,
  validateProjectSkillInstallationPreview,
  assertNoOverlappingProjectSkillRemovalTargets,
  type ProjectInstallationOptions,
  type ProjectSkillInstallationInspection,
  type ProjectSkillInstallationResult,
  type ProjectSkillInstallationTransaction,
  type ProjectSkillRemovalInspection,
  type ProjectSkillTreeAccess,
} from "./project-installation.js";
import {
  assessUpdateBatch,
  selectUpdateBatch,
  UpdateBatchSelectionError,
  type UpdateBatchAssessment,
  type UpdateBatchAssessmentItem,
} from "./update-batch.js";
import { applyUpdateBatch, previewSkillUpdate } from "./skill-update.js";
import {
  assertNoOverlappingUserGlobalSkillRemovals,
  inspectUserGlobalSkillRemoval,
  removeUserGlobalSkill,
  scanUserGlobalSkillInventory,
  type UserGlobalSkillInventory,
  type UserGlobalSkillRemovalInspection,
} from "./user-global-skill-inventory.js";

export interface CliDependencies {
  readonly operations?: SourceOperations;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly projectRoot?: string;
  readonly sourceAccess?: ProjectSkillTreeAccess;
  readonly installationOptions?: Omit<ProjectInstallationOptions, "projectRoot" | "sourceAccess">;
  /** Test/embedding seam for the manifest transaction boundary. */
  readonly projectManifestStore?: ProjectManifestStore;
  /** Home directory used by user-global installation; injectable for tests. */
  readonly homeDirectory?: string;
}

const USAGE = [
  "Usage:",
  "  agent-depot source list",
  "  agent-depot source add <url>",
  "  agent-depot source refresh <id> [--yes]",
  "  agent-depot source remove <id> [--skill <id|path>...] [--all] [--yes]",
  "  agent-depot source migrate <old-id> <new-id> (--skill <path>... | --all) [--yes]",
  "  agent-depot discover <source-id> [source-id...]",
  "  agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--yes] [--confirm-additional-host]",
  "  agent-depot install --scope project --manifest --portable-v1 [--yes] [--confirm-additional-host]",
  "  agent-depot update check --scope <project|user-global>",
  "  agent-depot update apply --scope <project|user-global> (--all | --skill <id|path>...) [--yes]",
  "  agent-depot uninstall [--skills] [--unmanaged-skill <exact-global-path>...] [--data] [--cli] [--yes]",
].join("\n");
const INSTALL_USAGE = "Usage: agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--overwrite --yes] [--confirm-additional-host]";
const DISCOVER_USAGE = "Usage: agent-depot discover <source-id> [source-id...]\nSelect at least one Source ID explicitly; run `agent-depot source list` to see registered Sources";
const REMOVE_SOURCE_USAGE = "Usage: agent-depot source remove <id> [--skill <id|path>...] [--all] [--yes]";
const MIGRATE_SOURCE_USAGE = "Usage: agent-depot source migrate <old-id> <new-id> (--skill <path>... | --all) [--yes]";
const UNINSTALL_USAGE = "Usage: agent-depot uninstall [--skills] [--unmanaged-skill <exact-global-path>...] [--data] [--cli] [--yes]";

/** Runs the CLI application and returns a process exit code. */
export async function runCli(argv: readonly string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.stdout ?? ((line: string) => console.log(line));
  const errorOutput = dependencies.stderr ?? ((line: string) => console.error(line));
  const operations = dependencies.operations ?? createSourceOperations({ homeDirectory: dependencies.homeDirectory });

  try {
    if (argv[0] === "install") {
      await runInstall(argv.slice(1), operations, dependencies, output);
      return 0;
    }

    if (argv[0] === "update") {
      return await runUpdate(argv.slice(1), operations, dependencies, output);
    }

    if (argv[0] === "uninstall") {
      await runUninstall(argv.slice(1), operations, dependencies, output);
      return 0;
    }

    if (argv[0] === "discover") {
      const sourceIds = argv.slice(1);
      requireSourceIds(sourceIds);
      const discoverSkills = operations.discoverSkills;
      if (!discoverSkills) {
        throw new CliUsageError("Discovery is unavailable in the configured Source operations");
      }

      let candidates: readonly SkillCandidate[];
      try {
        candidates = await discoverSkills.call(operations, sourceIds);
      } catch (error) {
        throw new Error(formatDiscoveryError(error));
      }
      for (const candidate of candidates) {
        output(formatCandidate(candidate));
      }
      return 0;
    }

    if (argv[0] !== "source") {
      throw new CliUsageError(USAGE);
    }

    const action = argv[1];
    const values = argv.slice(2);
    switch (action) {
      case "list":
        requireArgumentCount(values, 0, "source list");
        for (const source of await operations.listSources()) {
          output(formatSource(source));
        }
        return 0;
      case "add":
        requireArgumentCount(values, 1, "source add <url>");
        {
          const source = await operations.addGitSource(values[0]);
          output(`Added Git Source: ${source.id}\t${source.url}`);
        }
        return 0;
      case "refresh":
        if (values.length < 1 || values.length > 2 || (values.length === 2 && values[1] !== "--yes")) {
          throw new CliUsageError("Usage: agent-depot source refresh <id> [--yes]");
        }
        {
          const source = await findSource(operations, values[0]);
          if (source.kind === "builtin") {
            throw new BuiltInSourceError();
          }
          output(`Preview: refresh Git Source ${source.id} from ${source.url}`);
          if (values[1] !== "--yes") {
            throw new CliUsageError("Refresh not confirmed; rerun with --yes to continue");
          }
          const refreshed = await operations.refreshSource(source.id);
          output(`Refreshed Git Source: ${refreshed.id}\t${refreshed.url}`);
        }
        return 0;
      case "remove":
        await runSourceRemoval(values, operations, dependencies, output);
        return 0;
      case "migrate":
        await runSourceMigration(values, operations, dependencies, output);
        return 0;
      default:
        throw new CliUsageError(USAGE);
    }
  } catch (error) {
    errorOutput(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

/** Alias retained as a discoverable public CLI seam for embedding and tests. */
export const main = runCli;

interface RemoveSourceOptions {
  readonly sourceId: string;
  readonly all: boolean;
  readonly requested: readonly string[];
  readonly confirmed: boolean;
}

interface MigrateSourceOptions {
  readonly oldSourceId: string;
  readonly newSourceId: string;
  readonly all: boolean;
  readonly requested: readonly string[];
  readonly confirmed: boolean;
}

async function runSourceRemoval(
  argv: readonly string[],
  operations: SourceOperations,
  dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<void> {
  const options = parseRemoveSourceOptions(argv);
  const source = await findSource(operations, options.sourceId);
  if (source.kind === "builtin") {
    throw new BuiltInSourceError();
  }
  if (!operations.listUserGlobalInstallations || !operations.removeGitSource) {
    throw new Error("Configured Source operations cannot remove user-global Sources");
  }

  const installations = await operations.listUserGlobalInstallations();
  const dependent = installations.filter((selection) =>
    selection.source.kind === "external" && "url" in selection.source && selection.source.url === source.url,
  );
  const selected = options.all
    ? dependent
    : resolveRemovalSelections(dependent, options.requested);
  const homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
  const inspections: ProjectSkillRemovalInspection[] = [];

  output(`Preview: remove Git Source ${source.id} from ${source.url}`);
  output(`Dependent user-global Skills (${dependent.length}):`);
  for (const [index, selection] of dependent.entries()) {
    const location = selection.installation?.path ?? "missing installation location";
    output(`  [${index}] ${selection.path} -> ${location}${selected.includes(selection) ? " (selected for removal)" : " (kept)"}`);
  }
  output("  Default: keep all dependent Skills tracked by default after Source removal");

  for (const selection of selected) {
    const inspection = await inspectProjectSkillRemoval(selection, {
      projectRoot: homeDirectory,
      sourceAccess: { readSkillTree: async () => [] },
      ...dependencies.installationOptions,
    });
    inspections.push(inspection);
    output(`  remove Skill ${JSON.stringify(selection.path)} at ${inspection.paths.join(", ")}`);
    if (inspection.adopted) {
      output("    WARNING: this Skill was adopted; removal deletes content that Agent Depot did not create");
    }
    if (inspection.modified) {
      output("    WARNING: this Skill is locally modified or has no trusted baseline; removal deletes those changes");
    }
  }

  assertNoOverlappingProjectSkillRemovalTargets(inspections);
  requireConfirmation(options.confirmed, "Removal not confirmed; rerun with --yes after reviewing every Source and Skill preview");
  // Recheck every selected target before deleting the first one. A changed later
  // target must never result in a partially removed batch.
  const rechecked: ProjectSkillRemovalInspection[] = [];
  for (const selection of selected) {
    rechecked.push(await inspectProjectSkillRemoval(selection, {
      projectRoot: homeDirectory,
      sourceAccess: { readSkillTree: async () => [] },
      ...dependencies.installationOptions,
    }));
  }
  assertNoOverlappingProjectSkillRemovalTargets(rechecked);
  for (let index = 0; index < selected.length; index += 1) {
    const before = inspections[index]!;
    const after = rechecked[index]!;
    if (before.digest !== after.digest || before.adopted !== after.adopted || before.modified !== after.modified ||
      before.skillName !== after.skillName || before.paths.length !== after.paths.length ||
      before.paths.some((candidate, pathIndex) => candidate !== after.paths[pathIndex])) {
      throw new Error(`The inspected Skill removal target changed before deletion; no path was removed`);
    }
    await removeProjectSkill(selected[index]!, after, {
      projectRoot: homeDirectory,
      sourceAccess: { readSkillTree: async () => [] },
      ...dependencies.installationOptions,
    });
  }
  await operations.removeGitSource(source.id, selected);
  output(`Removed Git Source: ${source.id}`);
  if (selected.length > 0) {
    output(`Removed ${selected.length} dependent user-global Skill${selected.length === 1 ? "" : "s"}; other dependent Skills remain tracked`);
  }
}

function parseMigrateSourceOptions(argv: readonly string[]): MigrateSourceOptions {
  if (argv.length < 2 || argv[0]?.startsWith("--") || argv[1]?.startsWith("--")) {
    throw new CliUsageError(MIGRATE_SOURCE_USAGE);
  }
  const oldSourceId = argv[0]!;
  const newSourceId = argv[1]!;
  const requested: string[] = [];
  let all = false;
  let confirmed = false;
  for (let index = 2; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--all":
        if (all || requested.length > 0) throw new CliUsageError(MIGRATE_SOURCE_USAGE);
        all = true;
        break;
      case "--skill":
        if (all) throw new CliUsageError(MIGRATE_SOURCE_USAGE);
        requested.push(requireOptionValue(argv, ++index, "--skill"));
        break;
      case "--yes":
        confirmed = true;
        break;
      default:
        throw new CliUsageError(MIGRATE_SOURCE_USAGE);
    }
  }
  if (all === (requested.length > 0)) {
    throw new CliUsageError("Source migration requires exactly one selection mode: --all or one or more --skill paths");
  }
  return { oldSourceId, newSourceId, all, requested: Object.freeze(requested), confirmed };
}

async function runSourceMigration(
  argv: readonly string[],
  operations: SourceOperations,
  _dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<void> {
  const options = parseMigrateSourceOptions(argv);
  if (!operations.listUserGlobalInstallations || !operations.migrateUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot migrate user-global Source selections");
  }
  const oldSource = await findSource(operations, options.oldSourceId);
  const newSource = await findSource(operations, options.newSourceId);
  if (oldSource.kind !== "git" || newSource.kind !== "git") {
    throw new CliUsageError("Source migration requires two registered Git Sources; the built-in Source cannot be migrated");
  }
  if (oldSource.id === newSource.id) {
    throw new CliUsageError("Source migration requires two different registered Git Sources");
  }
  const installations = await operations.listUserGlobalInstallations();
  const dependent = installations.filter((selection) =>
    selection.source.kind === "external" && "url" in selection.source && selection.source.url === oldSource.url,
  );
  const selected = options.all ? dependent : resolveMigrationSelections(dependent, options.requested);
  const migrations: UserGlobalSkillMigration[] = [];
  output(`Preview: migrate user-global selections from ${oldSource.id} (${oldSource.url}) to ${newSource.id} (${newSource.url})`);
  output(`Dependent user-global Skills (${dependent.length}):`);
  for (const selection of dependent) {
    output(`  ${selection.path}${selected.includes(selection) ? " (selected for migration)" : " (kept)"}`);
  }

  for (const selection of selected) {
    const migration = await planUserGlobalSkillMigration(selection, newSource, operations);
    migrations.push(migration);
    const installation = migration.to.installation;
    output(`  migrate ${JSON.stringify(selection.path)} -> ${JSON.stringify(migration.to.source)}`);
    output(`    retain installation at ${JSON.stringify(installation?.path ?? "missing installation location")}; no files or project manifests are changed`);
    if (selection.installation?.baseline && installation?.resolvedVersion) {
      output("    preserve content baseline and replace resolved version with evidence from the new Source");
    } else if (selection.installation?.baseline) {
      output("    preserve content baseline; drop old resolved version evidence because it belongs to the old Source");
    } else {
      output("    preserve installation location/adoption only; no trusted version evidence is carried over");
    }
  }

  requireConfirmation(options.confirmed, "Migration not confirmed; rerun with --yes after reviewing every selected Skill");
  await operations.migrateUserGlobalInstallations(oldSource.id, newSource.id, migrations);
  output(`Migrated ${migrations.length} user-global Skill${migrations.length === 1 ? "" : "s"}; physical installations and project manifests were unchanged`);
}

async function planUserGlobalSkillMigration(
  selection: ProjectSkillSelection,
  newSource: Extract<Source, { readonly kind: "git" }>,
  operations: SourceOperations,
): Promise<UserGlobalSkillMigration> {
  const snapshot = operations.readSkillTreeSnapshot
    ? await operations.readSkillTreeSnapshot(newSource, selection.path)
    : undefined;
  const newBaseline = snapshot === undefined ? undefined : skillTreeBaseline(snapshot.files);
  if (snapshot !== undefined && !snapshot.files.some((file) => file.path === `${selection.path}/SKILL.md`)) {
    throw new Error(`Replacement Source does not contain selected Skill ${JSON.stringify(selection.path)}`);
  }
  if (selection.version.policy === "fixed" &&
    (snapshot?.resolvedVersion?.kind !== "git-commit" || snapshot.resolvedVersion.commit !== selection.version.version)) {
    throw new Error(`Cannot migrate fixed Skill ${JSON.stringify(selection.path)} without matching version evidence from the replacement Source`);
  }
  const contentMatches = selection.installation?.baseline !== undefined &&
    newBaseline !== undefined && selection.installation.baseline.digest === newBaseline.digest;
  const source = selection.version.policy === "fixed"
    ? { kind: "external" as const, url: newSource.url, ref: selection.version.version }
    : { kind: "external" as const, url: newSource.url };
  const installation = selection.installation === undefined
    ? undefined
    : {
      path: selection.installation.path,
      adopted: selection.installation.adopted,
      ...(selection.installation.baseline === undefined ? {} : { baseline: selection.installation.baseline }),
      ...(contentMatches && snapshot?.resolvedVersion === undefined ? {} :
        contentMatches && snapshot?.resolvedVersion !== undefined ? { resolvedVersion: snapshot.resolvedVersion } : {}),
    };
  return {
    from: selection,
    to: {
      ...selection,
      source,
      ...(installation === undefined ? {} : { installation }),
    },
  };
}

function resolveMigrationSelections(
  dependent: readonly ProjectSkillSelection[],
  requested: readonly string[],
): readonly ProjectSkillSelection[] {
  const selected: ProjectSkillSelection[] = [];
  for (const value of requested) {
    const candidate = dependent.find((selection) => selection.path === value);
    if (!candidate) {
      throw new CliUsageError(`Unknown dependent user-global Skill selection ${JSON.stringify(value)}`);
    }
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return Object.freeze(selected);
}

function parseRemoveSourceOptions(argv: readonly string[]): RemoveSourceOptions {
  if (argv.length === 0 || argv[0]?.startsWith("--")) {
    throw new CliUsageError(REMOVE_SOURCE_USAGE);
  }
  const sourceId = argv[0]!;
  const requested: string[] = [];
  let all = false;
  let confirmed = false;
  for (let index = 1; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--all":
        if (all) throw new CliUsageError(REMOVE_SOURCE_USAGE);
        if (requested.length > 0) throw new CliUsageError("source remove cannot combine --all with --skill");
        all = true;
        break;
      case "--skill":
        if (all) throw new CliUsageError("source remove cannot combine --all with --skill");
        requested.push(requireOptionValue(argv, ++index, "--skill"));
        break;
      case "--yes":
        confirmed = true;
        break;
      default:
        throw new CliUsageError(REMOVE_SOURCE_USAGE);
    }
  }
  return { sourceId, all, requested: Object.freeze(requested), confirmed };
}

function resolveRemovalSelections(
  dependent: readonly ProjectSkillSelection[],
  requested: readonly string[],
): readonly ProjectSkillSelection[] {
  const selected: ProjectSkillSelection[] = [];
  for (const value of requested) {
    const pathMatch = dependent.find((selection) => selection.path === value);
    const numeric = /^\d+$/u.test(value) ? Number(value) : undefined;
    const candidate = pathMatch ?? (numeric !== undefined && Number.isSafeInteger(numeric)
      ? dependent[numeric]
      : undefined);
    if (!candidate) {
      throw new CliUsageError(`Unknown dependent user-global Skill selection ${JSON.stringify(value)}`);
    }
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return Object.freeze(selected);
}

interface UninstallOptions {
  readonly skills: boolean;
  readonly unmanagedSkills: readonly string[];
  readonly data: boolean;
  readonly cli: boolean;
  readonly confirmed: boolean;
}

function parseUninstallOptions(argv: readonly string[]): UninstallOptions {
  let skills = false;
  const unmanagedSkills: string[] = [];
  let data = false;
  let cli = false;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--skills":
        if (skills) throw new CliUsageError(UNINSTALL_USAGE);
        skills = true;
        break;
      case "--unmanaged-skill": {
        const selected = requireOptionValue(argv, ++index, "--unmanaged-skill");
        if (unmanagedSkills.includes(selected)) throw new CliUsageError(`Duplicate --unmanaged-skill path ${JSON.stringify(selected)}`);
        unmanagedSkills.push(selected);
        break;
      }
      case "--data":
        if (data) throw new CliUsageError(UNINSTALL_USAGE);
        data = true;
        break;
      case "--cli":
        if (cli) throw new CliUsageError(UNINSTALL_USAGE);
        cli = true;
        break;
      case "--yes":
        confirmed = true;
        break;
      default:
        throw new CliUsageError(UNINSTALL_USAGE);
    }
  }
  if (!skills && unmanagedSkills.length === 0 && !data && !cli) {
    throw new CliUsageError("Select at least one uninstall choice: --skills, --unmanaged-skill, --data, or --cli");
  }
  return { skills, unmanagedSkills: Object.freeze(unmanagedSkills), data, cli, confirmed };
}

function assertUninstallCapabilities(options: UninstallOptions, operations: SourceOperations): void {
  if (options.skills && !operations.listUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot inspect user-global Skill installations");
  }
  if (options.skills && !operations.removeUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot reconcile removed user-global Skills");
  }
  if (options.unmanagedSkills.length > 0 && !operations.listUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot inspect managed paths before removing unmanaged Skills");
  }
  if (options.data && !operations.removeCatalogData) {
    throw new Error("Configured Source operations cannot remove user-global catalog data");
  }
}

async function previewManagedUninstall(
  options: UninstallOptions,
  installations: readonly ProjectSkillSelection[],
  removalOptions: ProjectInstallationOptions,
  output: (line: string) => void,
): Promise<ProjectSkillRemovalInspection[]> {
  const inspections: ProjectSkillRemovalInspection[] = [];
  if (!options.skills) {
    output("Managed Skills: preserve (not selected)");
    return inspections;
  }
  output(`Managed Skills (${installations.length}):`);
  for (const selection of installations) {
    const inspection = await inspectProjectSkillRemoval(selection, removalOptions);
    inspections.push(inspection);
    output(`  remove ${JSON.stringify(selection.path)} at ${inspection.paths.join(", ")}`);
    if (inspection.adopted) {
      output("    WARNING: this Skill was adopted; removal deletes content that Agent Depot did not create");
    }
    if (inspection.modified) {
      output("    WARNING: this Skill is locally modified or has no trusted baseline; removal deletes those changes");
    }
  }
  output("  Installation records are reconciled after each successful Skill removal");
  return inspections;
}

async function previewUnmanagedUninstall(
  options: UninstallOptions,
  homeDirectory: string,
  installations: readonly ProjectSkillSelection[],
  output: (line: string) => void,
): Promise<UserGlobalSkillRemovalInspection[]> {
  const inspections: UserGlobalSkillRemovalInspection[] = [];
  if (options.unmanagedSkills.length === 0) return inspections;
  output(`Unmanaged Skills (${options.unmanagedSkills.length}):`);
  for (const selectedPath of options.unmanagedSkills) {
    const inspection = await inspectUserGlobalSkillRemoval(selectedPath, {
      homeDirectory,
      managedInstallations: installations,
    });
    inspections.push(inspection);
    output(`  remove exact path ${JSON.stringify(inspection.path)}`);
    output("    WARNING: this is a permanent deletion; Agent Depot will not retain a backup");
    output("    WARNING: recovery through Agent Depot requires a resolvable Source and is not guaranteed");
  }
  output("  Unmanaged Skills are never inferred from a Source and no project scope is used");
  return inspections;
}

function outputDataAndCliUninstallPreview(options: UninstallOptions, output: (line: string) => void): void {
  if (options.data) {
    output("Catalog/configuration data: remove the user-global Source state file");
    output("  Git Source caches are retained");
    if (!options.skills) {
      output("  Managed Skills are preserved but become untracked when their state is removed");
    }
  } else {
    output("Catalog/configuration data: preserve (not selected)");
  }

  if (options.cli) {
    output("Persistent CLI: package-manager handoff only; Agent Depot will not invoke or infer a package manager");
  } else {
    output("Persistent CLI: preserve (not selected)");
  }
}

function assertNoManagedUnmanagedOverlap(
  managed: readonly ProjectSkillRemovalInspection[],
  unmanaged: readonly UserGlobalSkillRemovalInspection[],
  message: (unmanagedPath: string) => string,
): void {
  for (const managedInspection of managed) {
    for (const unmanagedInspection of unmanaged) {
      if (managedInspection.paths.some((managedPath) => pathsOverlap(managedPath, unmanagedInspection.path))) {
        throw new Error(message(unmanagedInspection.path));
      }
    }
  }
}

function assertRemovalInspectionUnchanged(before: ProjectSkillRemovalInspection, after: ProjectSkillRemovalInspection): void {
  const unchanged = before.digest === after.digest && before.adopted === after.adopted && before.modified === after.modified &&
    before.skillName === after.skillName && before.paths.length === after.paths.length &&
    before.paths.every((candidate, pathIndex) => candidate === after.paths[pathIndex]);
  if (!unchanged) {
    throw new Error("The inspected Skill removal target changed before deletion; no path was removed");
  }
}

interface UninstallRemovalContext {
  readonly operations: SourceOperations;
  readonly homeDirectory: string;
  readonly removalOptions: ProjectInstallationOptions;
}

async function removeManagedUninstallSkills(
  context: UninstallRemovalContext,
  selected: readonly ProjectSkillSelection[],
  inspections: readonly ProjectSkillRemovalInspection[],
  rechecked: readonly ProjectSkillRemovalInspection[],
  initialManaged: readonly ProjectSkillSelection[],
): Promise<readonly ProjectSkillSelection[]> {
  const { operations, removalOptions } = context;
  let expectedManagedInstallations = initialManaged;
  for (let index = 0; index < selected.length; index += 1) {
    assertRemovalInspectionUnchanged(inspections[index]!, rechecked[index]!);
    const latestManagedInstallations = await operations.listUserGlobalInstallations!();
    assertManagedInstallationRecordsUnchanged(expectedManagedInstallations, latestManagedInstallations);
    const selection = selected[index]!;
    await removeProjectSkill(selection, rechecked[index]!, removalOptions);
    await operations.removeUserGlobalInstallations!([selection]);
    expectedManagedInstallations = await operations.listUserGlobalInstallations!();
  }
  return expectedManagedInstallations;
}

async function removeUnmanagedUninstallSkills(
  context: UninstallRemovalContext,
  inspections: readonly UserGlobalSkillRemovalInspection[],
  expectedManagedInstallations: readonly ProjectSkillSelection[],
): Promise<void> {
  const { operations, homeDirectory } = context;
  for (const inspection of inspections) {
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
}

function outputUninstallSummary(options: UninstallOptions, removedManagedCount: number, output: (line: string) => void): void {
  if (options.skills) {
    output(`Removed ${removedManagedCount} managed user-global Skill${removedManagedCount === 1 ? "" : "s"}`);
  }
  if (options.unmanagedSkills.length > 0) {
    output(`Permanently deleted ${options.unmanagedSkills.length} unmanaged user-global Skill${options.unmanagedSkills.length === 1 ? "" : "s"}`);
  }
  if (options.data) {
    output("Removed user-global catalog/configuration data; Git Source caches were retained");
  }
  if (options.cli) {
    output("Handoff: remove the persistent Agent Depot CLI with the package manager that installed it; no package manager was invoked or inferred");
  }
}

async function runUninstall(
  argv: readonly string[],
  operations: SourceOperations,
  dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<void> {
  const options = parseUninstallOptions(argv);
  assertUninstallCapabilities(options, operations);

  const homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
  // Keep the initial selection snapshot separate from the reconciled records.
  // Removing one entry shrinks the persisted list, but must not skip the next
  // selected entry or change its inspection/removal order.
  const selectedInstallations = options.skills || options.unmanagedSkills.length > 0
    ? await operations.listUserGlobalInstallations!()
    : [];
  const removalOptions: ProjectInstallationOptions = {
    projectRoot: homeDirectory,
    sourceAccess: { readSkillTree: async () => [] },
    ...dependencies.installationOptions,
  };
  const context: UninstallRemovalContext = { operations, homeDirectory, removalOptions };

  output("Uninstall preview (scope: user-global only)");
  const inspections = await previewManagedUninstall(options, selectedInstallations, removalOptions, output);
  const unmanagedInspections = await previewUnmanagedUninstall(options, homeDirectory, selectedInstallations, output);
  outputDataAndCliUninstallPreview(options, output);

  assertNoOverlappingProjectSkillRemovalTargets(inspections);
  assertNoOverlappingUserGlobalSkillRemovals(unmanagedInspections);
  assertNoManagedUnmanagedOverlap(inspections, unmanagedInspections, (unmanagedPath) =>
    `Cannot remove unmanaged Skill ${JSON.stringify(unmanagedPath)} because it overlaps a selected managed Skill target; no path was changed`);
  if (options.skills || options.unmanagedSkills.length > 0 || options.data) {
    requireConfirmation(options.confirmed, "Uninstall not confirmed; rerun with --yes after reviewing every user-global deletion preview");
  }

  const rechecked: ProjectSkillRemovalInspection[] = [];
  if (options.skills) {
    for (const selection of selectedInstallations) {
      rechecked.push(await inspectProjectSkillRemoval(selection, removalOptions));
    }
  }
  assertNoOverlappingProjectSkillRemovalTargets(rechecked);
  const unmanagedRechecked: UserGlobalSkillRemovalInspection[] = [];
  for (const inspection of unmanagedInspections) {
    unmanagedRechecked.push(await inspectUserGlobalSkillRemoval(inspection.path, {
      homeDirectory,
      managedInstallations: selectedInstallations,
    }));
  }
  assertNoOverlappingUserGlobalSkillRemovals(unmanagedRechecked);
  assertNoManagedUnmanagedOverlap(rechecked, unmanagedRechecked, () =>
    "An unmanaged Skill target changed into an overlap with a selected managed Skill; no path was changed");

  const expectedManagedInstallations = options.skills
    ? await removeManagedUninstallSkills(context, selectedInstallations, inspections, rechecked, selectedInstallations)
    : selectedInstallations;
  await removeUnmanagedUninstallSkills(context, unmanagedInspections, expectedManagedInstallations);

  if (options.data) {
    await operations.removeCatalogData!();
  }
  outputUninstallSummary(options, selectedInstallations.length, output);
}

interface UpdateOptions {
  readonly action: "check" | "apply";
  readonly scope: "project" | "user-global";
  readonly all: boolean;
  readonly requested: readonly string[];
  readonly confirmed: boolean;
}

async function runUpdate(
  argv: readonly string[],
  operations: SourceOperations,
  dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<number> {
  const options = parseUpdateOptions(argv);
  const sourceAccess = dependencies.sourceAccess ?? defaultProjectSkillTreeAccess();
  const projectRoot = options.scope === "project"
    ? path.resolve(dependencies.projectRoot ?? process.cwd())
    : path.resolve(dependencies.homeDirectory ?? homedir());
  const manifestStore = options.scope === "project"
    ? dependencies.projectManifestStore ?? new ProjectManifestStore(defaultProjectManifestPath(projectRoot))
    : undefined;
  const installed = options.scope === "project"
    ? (await manifestStore!.load()).skills
    : await requireUserGlobalInstallations(operations);
  const resolveSource = operations.resolveProjectSource
    ? (source: ProjectSource) => operations.resolveProjectSource!(source)
    : resolveProjectSource;
  const assessment = await assessUpdateBatch(installed, { sourceAccess, resolveSource });
  const userGlobalInventory = options.action === "check" && options.scope === "user-global"
    ? await scanUserGlobalSkillInventory({ homeDirectory: projectRoot, managedInstallations: installed })
    : undefined;

  outputUpdateAssessment(assessment, options.scope, output, userGlobalInventory);
  if (options.action === "check") {
    return 0;
  }

  const requested = options.all
    ? "all" as const
    : resolveUpdateSelectionIds(assessment, options.requested);
  let selected: readonly UpdateBatchAssessmentItem[];
  try {
    selected = selectUpdateBatch(assessment, requested);
  } catch (error) {
    if (error instanceof UpdateBatchSelectionError) throw new CliUsageError(error.message);
    throw error;
  }

  const previewFailures: Array<{ readonly item: UpdateBatchAssessmentItem; readonly error: string }> = [];
  const installationFileSystem = dependencies.installationOptions?.fileSystem;
  for (const item of selected) {
    try {
      outputUpdatePreview(await previewSkillUpdate(item, {
        projectRoot,
        scope: options.scope,
        sourceAccess,
        sourceOperations: operations,
        ...(manifestStore === undefined ? {} : { projectManifestStore: manifestStore }),
        ...(installationFileSystem === undefined ? {} : { installationFileSystem }),
      }), options.scope, output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      previewFailures.push({ item, error: message });
      output(`Preview failed for ${JSON.stringify(item.id)}: ${message}`);
    }
  }

  requireConfirmation(options.confirmed, "Update not confirmed; rerun with --yes after reviewing every candidate preview");
  const result = await applyUpdateBatch(selected, {
    projectRoot,
    scope: options.scope,
    sourceAccess,
    sourceOperations: operations,
    ...(manifestStore === undefined ? {} : { projectManifestStore: manifestStore }),
    ...(installationFileSystem === undefined ? {} : { installationFileSystem }),
    // The callback is invoked independently for every candidate. In particular,
    // a modified installation is never overwritten unless this invocation was
    // explicitly confirmed with --yes.
    confirm: async () => ({
      overwriteModifiedInstallation: options.confirmed,
      externalMethod: options.confirmed,
    }),
  });

  for (const failure of previewFailures) {
    if (!result.failed.some((item) => item.id === failure.item.id)) {
      output(`Preview failure was not selected for application: ${JSON.stringify(failure.item.id)}`);
    }
  }
  for (const item of result.updated) {
    output(`Updated Skill ${JSON.stringify(item.selection.path)} (${item.id})`);
  }
  for (const item of result.failed) {
    output(`Failed Skill ${JSON.stringify(item.selection.path)} (${item.id}): ${item.error ?? "unknown error"}`);
  }
  output(`Update summary: ${result.updated.length} updated, ${result.failed.length} failed`);
  return result.failed.length === 0 ? 0 : 1;
}

function parseUpdateOptions(argv: readonly string[]): UpdateOptions {
  const action = argv[0];
  if (action !== "check" && action !== "apply") {
    throw new CliUsageError(USAGE);
  }

  let scope: string | undefined;
  let all = false;
  let confirmed = false;
  const requested: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--scope":
        scope = requireOptionValue(argv, ++index, "--scope");
        break;
      case "--all":
        all = true;
        break;
      case "--skill":
        requested.push(requireOptionValue(argv, ++index, "--skill"));
        break;
      case "--yes":
        confirmed = true;
        break;
      default:
        throw new CliUsageError(USAGE);
    }
  }

  if (scope !== "project" && scope !== "user-global") {
    throw new CliUsageError("Update scope must be explicit: use --scope project or --scope user-global");
  }
  if (action === "check" && (all || requested.length > 0 || confirmed)) {
    throw new CliUsageError("update check only accepts --scope; use update apply to select and apply updates");
  }
  if (action === "apply" && (all === (requested.length > 0))) {
    throw new CliUsageError("update apply requires exactly one selection mode: --all or one or more --skill values");
  }
  return {
    action,
    scope: scope as "project" | "user-global",
    all,
    requested: Object.freeze(requested),
    confirmed,
  };
}

async function requireUserGlobalInstallations(operations: SourceOperations): Promise<readonly ProjectSkillSelection[]> {
  if (!operations.listUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot inspect user-global Skill updates");
  }
  return operations.listUserGlobalInstallations();
}

function resolveUpdateSelectionIds(
  assessment: UpdateBatchAssessment,
  requested: readonly string[],
): readonly (string | number)[] {
  return requested.map((value) => {
    const numeric = /^\d+$/u.test(value) ? Number(value) : undefined;
    if (numeric !== undefined && Number.isSafeInteger(numeric)) return numeric;
    if (assessment.items.some((item) => item.id === value)) return value;
    const matches = assessment.items.filter((item) => item.selection?.path === value);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      throw new CliUsageError(`Skill path ${JSON.stringify(value)} is ambiguous; select its full update ID`);
    }
    throw new CliUsageError(`Unknown update Skill selection ${JSON.stringify(value)}`);
  });
}

function outputUpdateAssessment(
  assessment: UpdateBatchAssessment,
  scope: "project" | "user-global",
  output: (line: string) => void,
  userGlobalInventory?: UserGlobalSkillInventory,
): void {
  output(`Update check (scope: ${scope})`);
  output(`Updateable (${assessment.updateable.length}):`);
  for (const item of assessment.updateable) outputUpdateItem(item, output);
  output(`Current (${assessment.current.length}):`);
  for (const item of assessment.current) outputUpdateItem(item, output);
  output(`Unknown (${assessment.unknown.length}):`);
  for (const item of assessment.unknown) outputUpdateItem(item, output);
  if (userGlobalInventory === undefined) return;

  output(`Unmanaged (${userGlobalInventory.unmanaged.length}):`);
  for (const entry of userGlobalInventory.unmanaged) output(`  ${entry.path}`);
  if (userGlobalInventory.skipped.length === 0) return;

  output(`Skipped/unsafe entries (${userGlobalInventory.skipped.length}):`);
  for (const entry of userGlobalInventory.skipped) {
    output(`  ${entry.path}: ${entry.detail ?? entry.reason}`);
  }
  output("  Skipped/unsafe entries are not Unmanaged entries or removal candidates; inspect them manually.");
}

function outputUpdateItem(item: UpdateBatchAssessmentItem, output: (line: string) => void): void {
  const selection = item.selection as Partial<ProjectSkillSelection> | undefined;
  output(`  [${item.index}] ${item.id}${typeof selection?.path === "string" ? ` path=${selection.path}` : ""}: ${item.reason}`);
}

function outputUpdatePreview(
  plan: Awaited<ReturnType<typeof previewSkillUpdate>>,
  scope: "project" | "user-global",
  output: (line: string) => void,
): void {
  output(`Preview: update Skill ${JSON.stringify(plan.selection.path)} from ${plan.source.id} (scope: ${scope})`);
  output(`  target: ${plan.target}`);
  output(`  proposed changes: replace ${plan.snapshot.files.length} managed files and persist the new version/content baseline`);
  if (plan.overwriteRequired) {
    output("  WARNING: the installed Skill has local modifications; --yes explicitly confirms replacing them");
  }
  if (plan.methodPreview) {
    output(`  external command: argv=${JSON.stringify(plan.methodPreview.argv)}`);
    output(`  external cwd: ${JSON.stringify(plan.methodPreview.cwd)}`);
    output(`  external target: ${JSON.stringify(plan.methodPreview.target)}`);
    output("  declared changes:");
    for (const change of plan.methodPreview.declaredChanges) output(`    ${change}`);
    output(`  WARNING: ${plan.methodPreview.warning}`);
  }
}

async function runInstall(
  argv: readonly string[],
  operations: SourceOperations,
  dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<void> {
  const options = parseInstallOptions(argv);
  const sourceAccess = dependencies.sourceAccess ?? defaultProjectSkillTreeAccess();
  if (options.scope === "user-global") {
    await runUserGlobalInstall(options, operations, dependencies, sourceAccess, output);
    return;
  }

  const projectRoot = path.resolve(dependencies.projectRoot ?? process.cwd());
  const manifestStore = dependencies.projectManifestStore ?? new ProjectManifestStore(defaultProjectManifestPath(projectRoot));

  if (options.fromManifest) {
    const manifest = await manifestStore.load();
    if (manifest.skills.length === 0) {
      throw new CliUsageError("The project manifest contains no selected Skills");
    }
    if (!options.portableV1) {
      throw new CliUsageError("Compatibility is not known for a manifest install; rerun with --portable-v1 after reviewing the Skill");
    }
    const resolved = await resolveManifestSelections(manifest, operations, sourceAccess, options.confirmed);
    if (resolved.some((item) => item.method !== undefined) && resolved.length > 1) {
      throw new SourceMetadataError("A batch install containing an external method is refused because command side effects cannot be rolled back safely; install that Skill separately");
    }
    // Inspect every physical destination before printing a confirmation preview.
    // Two different manifest selections can have different Source/path
    // identities while still resolving to the same basename directory.
    const inspections = await inspectManifestInstallations(resolved, projectRoot, sourceAccess, dependencies);
    for (let index = 0; index < resolved.length; index += 1) {
      const item = resolved[index]!;
      outputInstallPreview(item.selection, item.source, projectRoot, output, item.files, item.method, "project", inspections[index], false, options.confirmed);
    }
    requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");
    for (const inspection of inspections) {
      rejectInstallationCollision(inspection, false);
    }

    const transactions: ProjectSkillInstallationTransaction[] = [];
    const installed: Array<{ readonly item: ResolvedManifestSelection; readonly result: ProjectSkillInstallationResult }> = [];
    let methodFailed = false;
    try {
      for (let index = 0; index < resolved.length; index += 1) {
        const item = resolved[index]!;
        const transaction = await installOne(item.selection, item.source, sourceAccess, projectRoot, dependencies, item.method, options.portableV1, item.files, item.resolvedVersion, options.confirmAdditionalHostExposure, false, inspections[index]);
        if (transaction) {
          transactions.push(transaction);
          installed.push({ item, result: transaction.result });
        }
      }
      const nextManifest = parseProjectManifest({
        version: 1,
        skills: manifest.skills.map((selection) => {
          const installedSelection = installed.find(({ item }) =>
            JSON.stringify([item.selection.source, item.selection.path]) === JSON.stringify([selection.source, selection.path]),
          );
          return installedSelection === undefined
            ? selection
            : selectionWithInstallation(installedSelection.item.selection, installedSelection.result, projectRoot);
        }),
      });
      await manifestStore.save(nextManifest);
      for (const { item, result } of installed) {
        outputInstallationResult(result, projectRoot, output);
        try {
          await executeOrRejectMethod(item, operations, projectRoot);
        } catch (error) {
          methodFailed = true;
          throw externalMethodFailure(error);
        }
      }
    } catch (error) {
      if (methodFailed) {
        throw error;
      }
      await rollbackTransactions(transactions, error);
    }
    return;
  }

  if (!options.sourceId || !options.skillPath || !options.version || options.hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  const { source, projectSource, selection } = await selectInstallSource({ ...options, sourceId: options.sourceId, skillPath: options.skillPath, version: options.version }, operations);

  const existing = await manifestStore.load();
  if (existing.skills.some((candidate) => JSON.stringify(candidate.source) === JSON.stringify(selection.source) && candidate.path === selection.path)) {
    throw new CliUsageError(`Skill selection ${JSON.stringify(selection.path)} is already recorded in ${manifestStore.path}; already managed Skills must be changed with update apply`);
  }
  const { resolvedSource, resolved, installationInspection } = await resolveInstallInspection(selection, source, projectSource, projectRoot, options, operations, dependencies, sourceAccess);
  outputInstallPreview(selection, source, projectRoot, output, resolved.files, resolved.method, "project", installationInspection, options.overwrite, options.confirmed);
  requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");
  const protectedPaths = assertNoManagedInstallationOverlap(existing.skills, selection, installationInspection, projectRoot, options.overwrite);
  rejectInstallationCollision(installationInspection, options.overwrite);

  const transaction = await installOne(selection, resolvedSource, sourceAccess, projectRoot, dependencies, resolved.method, options.portableV1, resolved.files, resolved.resolvedVersion, options.confirmAdditionalHostExposure, options.overwrite, installationInspection, protectedPaths);
  const nextManifest = parseProjectManifest({
    version: 1,
    skills: [...existing.skills, selectionWithInstallation(selection, transaction.result, projectRoot)],
  });
  try {
    await manifestStore.save(nextManifest);
  } catch (error) {
    if (transaction) {
      await rollbackTransactions([transaction], error);
    }
    throw error;
  }
  outputInstallationResult(transaction.result, projectRoot, output);
  try {
    await executeOrRejectMethod(resolved, operations, projectRoot);
  } catch (error) {
    throw externalMethodFailure(error);
  }
  output(`Saved project manifest: ${manifestStore.path}`);
}

async function runUserGlobalInstall(
  options: InstallOptions,
  operations: SourceOperations,
  dependencies: CliDependencies,
  sourceAccess: ProjectSkillTreeAccess,
  output: (line: string) => void,
): Promise<void> {
  if (options.fromManifest || !options.sourceId || !options.skillPath || !options.version || options.hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  if (!operations.listUserGlobalInstallations || !operations.addUserGlobalInstallation) {
    throw new Error("Configured Source operations cannot manage user-global installation state");
  }

  const homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
  const { source, projectSource, selection } = await selectInstallSource({ ...options, sourceId: options.sourceId, skillPath: options.skillPath, version: options.version }, operations);

  const existing = await operations.listUserGlobalInstallations();
  if (existing.some((candidate) => JSON.stringify([candidate.source, candidate.path]) === JSON.stringify([selection.source, selection.path]))) {
    throw new CliUsageError(`Skill selection ${JSON.stringify(selection.path)} is already recorded in user-global state; already managed Skills must be changed with update apply`);
  }
  const { resolvedSource, resolved, installationInspection } = await resolveInstallInspection(selection, source, projectSource, homeDirectory, options, operations, dependencies, sourceAccess);
  outputInstallPreview(selection, source, homeDirectory, output, resolved.files, resolved.method, "user-global", installationInspection, options.overwrite, options.confirmed);
  requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");
  const protectedPaths = assertNoManagedInstallationOverlap(existing, selection, installationInspection, homeDirectory, options.overwrite);
  rejectInstallationCollision(installationInspection, options.overwrite);

  const transaction = await installOne(
    selection,
    resolvedSource,
    sourceAccess,
    homeDirectory,
    dependencies,
    resolved.method,
    options.portableV1,
    resolved.files,
    resolved.resolvedVersion,
    options.confirmAdditionalHostExposure,
    options.overwrite,
    installationInspection,
    protectedPaths,
  );
  const record = selectionWithInstallation(selection, transaction.result, homeDirectory);
  try {
    await operations.addUserGlobalInstallation(record);
  } catch (error) {
    await rollbackTransactions([transaction], error);
  }
  outputInstallationResult(transaction.result, homeDirectory, output);
  try {
    await executeOrRejectMethod(resolved, operations, homeDirectory);
  } catch (error) {
    throw externalMethodFailure(error);
  }
  output("Saved user-global installation state: shared Source state");
}

interface InstallOptions {
  readonly scope: "project" | "user-global";
  readonly fromManifest: boolean;
  readonly sourceId?: string;
  readonly skillPath?: string;
  readonly hosts: readonly ProjectHost[];
  readonly version?: VersionPolicy;
  readonly ref?: string;
  readonly method?: unknown;
  readonly portableV1: boolean;
  readonly confirmed: boolean;
  readonly overwrite: boolean;
  readonly confirmAdditionalHostExposure: boolean;
}

type InstallSelectionOptions = InstallOptions & {
  readonly sourceId: string;
  readonly skillPath: string;
  readonly version: VersionPolicy;
};

async function selectInstallSource(
  options: InstallSelectionOptions,
  operations: SourceOperations,
): Promise<{ source: Source; projectSource: ProjectSource; selection: ProjectSkillSelection }> {
  const source = await findSource(operations, options.sourceId);
  const projectSource = projectSourceFromSource(source, options.ref, options.version);
  const selection = parseProjectManifest({
    version: 1,
    skills: [{
      source: projectSource,
      path: options.skillPath,
      version: options.version,
      hosts: options.hosts,
      ...(options.method === undefined ? {} : { methods: { install: options.method } }),
    }],
  }).skills[0];
  if (!selection) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  if (!options.portableV1) {
    throw new CliUsageError("Compatibility is not known; rerun with --portable-v1 after reviewing the Skill");
  }
  return { source, projectSource, selection };
}

async function resolveInstallInspection(
  selection: ProjectSkillSelection,
  source: Source,
  projectSource: ProjectSource,
  installationRoot: string,
  options: InstallOptions,
  operations: SourceOperations,
  dependencies: CliDependencies,
  sourceAccess: ProjectSkillTreeAccess,
) {
  const initialResolvedSource = projectSource.kind === "builtin"
    ? source
    : operations.resolveProjectSource
      ? await operations.resolveProjectSource(projectSource)
      : resolveProjectSource(projectSource);
  const resolvedSource = await refreshResolvedSource(operations, projectSource, initialResolvedSource, options.confirmed);
  const resolved = await resolveSelection(selection, resolvedSource, operations, sourceAccess);
  const installationInspection = await inspectProjectSkillInstallation({
    selection,
    source: resolvedSource,
    previewTree: resolved.files,
    portableV1: options.portableV1,
    confirmAdditionalHostExposure: options.confirmAdditionalHostExposure,
    resolvedVersion: resolved.resolvedVersion,
  }, {
    projectRoot: installationRoot,
    sourceAccess,
    ...dependencies.installationOptions,
  });
  return { resolvedSource, resolved, installationInspection };
}

function parseInstallOptions(argv: readonly string[]): InstallOptions {
  let scope: string | undefined;
  let sourceId: string | undefined;
  let skillPath: string | undefined;
  let versionValue: string | undefined;
  let ref: string | undefined;
  let method: unknown;
  let fromManifest = false;
  let portableV1 = false;
  let confirmed = false;
  let overwrite = false;
  let confirmAdditionalHostExposure = false;
  const hosts: ProjectHost[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--scope":
        scope = requireOptionValue(argv, ++index, "--scope");
        break;
      case "--source":
        sourceId = requireOptionValue(argv, ++index, "--source");
        break;
      case "--skill":
        skillPath = requireOptionValue(argv, ++index, "--skill");
        break;
      case "--host":
        for (const host of requireOptionValue(argv, ++index, "--host").split(",")) {
          if (!PROJECT_HOSTS.includes(host as ProjectHost) || hosts.includes(host as ProjectHost)) {
            throw new CliUsageError(`Unsupported or duplicate Host ${JSON.stringify(host)}`);
          }
          hosts.push(host as ProjectHost);
        }
        break;
      case "--version":
        versionValue = requireOptionValue(argv, ++index, "--version");
        break;
      case "--ref":
        ref = requireOptionValue(argv, ++index, "--ref");
        break;
      case "--method":
        method = parseMethodOption(requireOptionValue(argv, ++index, "--method"));
        break;
      case "--manifest":
        fromManifest = true;
        break;
      case "--portable-v1":
        portableV1 = true;
        break;
      case "--yes":
        confirmed = true;
        break;
      case "--overwrite":
        overwrite = true;
        break;
      case "--confirm-additional-host":
        confirmAdditionalHostExposure = true;
        break;
      default:
        throw new CliUsageError(INSTALL_USAGE);
    }
  }

  if (scope !== "project" && scope !== "user-global") {
    throw new CliUsageError("Installation scope must be explicit: use --scope project or --scope user-global");
  }
  if (fromManifest && scope !== "project") {
    throw new CliUsageError("--manifest is only supported with --scope project");
  }
  if (fromManifest && (sourceId !== undefined || skillPath !== undefined || versionValue !== undefined || ref !== undefined || method !== undefined || hosts.length > 0 || overwrite)) {
    throw new CliUsageError("--manifest cannot be combined with --source, --skill, --host, --version, --ref, --method, or --overwrite");
  }
  if (!fromManifest && !versionValue && (sourceId || skillPath || ref || hosts.length > 0)) {
    throw new CliUsageError("--version is required for a selected Skill");
  }
  if (!fromManifest && versionValue === undefined && sourceId === undefined && skillPath === undefined && ref === undefined && hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  return {
    scope: scope as "project" | "user-global",
    fromManifest,
    sourceId,
    skillPath,
    hosts: Object.freeze(hosts),
    version: versionValue === undefined ? undefined : parseVersionOption(versionValue),
    ref,
    method,
    portableV1,
    confirmed,
    overwrite,
    confirmAdditionalHostExposure,
  };
}

function parseMethodOption(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new CliUsageError(`--method must be valid JSON${detail}`);
  }
}

function parseVersionOption(value: string): VersionPolicy {
  if (value === "latest") {
    return { policy: "latest" };
  }
  const version = value.startsWith("fixed:") ? value.slice("fixed:".length) : value;
  if (!version || /\s/u.test(version) || Array.from(version).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) {
    throw new CliUsageError("--version fixed:<value> must provide a non-empty version without whitespace or control characters");
  }
  return { policy: "fixed", version };
}

function requireOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`Missing value for ${option}`);
  }
  return value;
}

interface ResolvedManifestSelection {
  readonly selection: ProjectSkillSelection;
  readonly source: Source;
  readonly files: readonly SkillTreeFile[];
  readonly resolvedVersion?: ResolvedVersionEvidence;
  readonly method?: SourceInstallationMethod;
}

async function resolveManifestSelections(
  manifest: ProjectManifest,
  operations: SourceOperations,
  sourceAccess: ProjectSkillTreeAccess,
  confirmed: boolean,
): Promise<readonly ResolvedManifestSelection[]> {
  const resolved: ResolvedManifestSelection[] = [];
  for (const selection of manifest.skills) {
    const initialSource = operations.resolveProjectSource
      ? await operations.resolveProjectSource(selection.source)
      : resolveProjectSource(selection.source);
    const source = await refreshResolvedSource(operations, selection.source, initialSource, confirmed);
    resolved.push(await resolveSelection(selection, source, operations, sourceAccess));
  }
  return Object.freeze(resolved);
}

async function inspectManifestInstallations(
  resolved: readonly ResolvedManifestSelection[],
  projectRoot: string,
  sourceAccess: ProjectSkillTreeAccess,
  dependencies: CliDependencies,
): Promise<readonly ProjectSkillInstallationInspection[]> {
  const inspections: ProjectSkillInstallationInspection[] = [];
  const owners = new Map<string, string>();
  for (const item of resolved) {
    const inspection = await inspectProjectSkillInstallation({
      selection: item.selection,
      source: item.source,
      previewTree: item.files,
      portableV1: true,
      resolvedVersion: item.resolvedVersion,
    }, {
      projectRoot,
      sourceAccess,
      ...dependencies.installationOptions,
    });
    // Reserve both known Host paths, not only the currently selected target:
    // a later adoption decision may choose either physical location.
    for (const candidate of [inspection.canonicalPath, inspection.claudePath]) {
      const normalized = path.resolve(candidate);
      const previous = owners.get(normalized);
      if (previous !== undefined) {
        throw new CliUsageError(
          `Manifest selections ${JSON.stringify(previous)} and ${JSON.stringify(item.selection.path)} resolve to the same physical installation target ${JSON.stringify(normalized)}; remove one record before confirmation; no path was changed`,
        );
      }
      owners.set(normalized, item.selection.path);
    }
    inspections.push(inspection);
  }
  return Object.freeze(inspections);
}

async function resolveSelection(
  selection: ProjectSkillSelection,
  source: Source,
  operations: SourceOperations,
  sourceAccess: ProjectSkillTreeAccess,
): Promise<ResolvedManifestSelection> {
  const preview = await readPreviewTree(sourceAccess, source, selection);
  await validateProjectSkillInstallationPreview({
    selection,
    source,
    previewTree: preview.files,
    portableV1: true,
  }, sourceAccess);
  // An explicitly configured method is authoritative. Avoid reading source metadata
  // when it is present so an invalid fallback cannot override user intent.
  const method = selection.methods?.install ?? await readStructuredMethod(operations, source, selection.path, preview.files);
  // The default Source access returns this evidence with the immutable tree. The
  // resolver fallback preserves compatibility for embedders with the older seam.
  const resolvedVersion = preview.resolvedVersion
    ?? await operations.resolveSourceVersion?.(source)
    ?? (source.kind === "builtin" && AGENT_DEPOT_PACKAGE_VERSION !== undefined
      ? Object.freeze({ kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION })
      : undefined);
  return Object.freeze({ selection, source, files: preview.files, resolvedVersion, method });
}

interface PreviewTree {
  readonly files: readonly SkillTreeFile[];
  readonly resolvedVersion?: ResolvedVersionEvidence;
}

async function refreshResolvedSource(
  operations: SourceOperations,
  projectSource: ProjectSource,
  source: Source,
  confirmed: boolean,
): Promise<Source> {
  if (!confirmed || source.kind === "builtin" || !operations.refreshProjectSource) {
    return source;
  }
  const refreshed = await operations.refreshProjectSource(projectSource);
  if (refreshed.kind !== source.kind || refreshed.id !== source.id ||
    (refreshed.kind === "git" && source.kind === "git" && refreshed.url !== source.url)) {
    throw new Error(`Refreshed Source identity changed from ${JSON.stringify(source.id)} to ${JSON.stringify(refreshed.id)}; no installation was attempted`);
  }
  return refreshed;
}

async function readPreviewTree(
  sourceAccess: ProjectSkillTreeAccess,
  source: Source,
  selection: ProjectSkillSelection,
): Promise<PreviewTree> {
  const captured = sourceAccess.readSkillTreeSnapshot
    ? await sourceAccess.readSkillTreeSnapshot(source, selection.path)
    : { files: await sourceAccess.readSkillTree(source, selection.path) };
  const prefix = `${selection.path}/`;
  const files = captured.files;
  if (!files.some((file) => file.path === `${selection.path}/SKILL.md`)) {
    throw new Error(`Selected Skill ${JSON.stringify(selection.path)} does not contain SKILL.md`);
  }
  const seen = new Set<string>();
  const snapshot = files.map((file) => {
    const relativePath = file.path.slice(prefix.length);
    if (!file.path.startsWith(prefix) || !isSafePreviewPath(relativePath) || seen.has(relativePath)) {
      throw new Error(`Selected Skill returned an unsafe or duplicate file path: ${JSON.stringify(file.path)}`);
    }
    seen.add(relativePath);
    return Object.freeze({
      path: file.path,
      content: Uint8Array.from(file.content),
      executable: file.executable,
    });
  });
  return Object.freeze({ files: Object.freeze(snapshot), resolvedVersion: captured.resolvedVersion });
}

function isSafePreviewPath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") &&
    normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function readStructuredMethod(
  operations: SourceOperations,
  source: Source,
  skillPath: string,
  previewTree: readonly SkillTreeFile[],
): Promise<SourceInstallationMethod | undefined> {
  if (!operations.readInstallationMethod) {
    return undefined;
  }
  const metadata = await operations.readInstallationMethod(source, skillPath, previewTree);
  return metadata === undefined ? undefined : parseSourceInstallationMethod(metadata);
}

function outputInstallPreview(
  selection: ProjectSkillSelection,
  source: Source,
  projectRoot: string,
  output: (line: string) => void,
  files: readonly SkillTreeFile[],
  method: SourceInstallationMethod | undefined,
  scope: "project" | "user-global",
  inspection: ProjectSkillInstallationInspection | undefined,
  overwrite: boolean,
  confirmed: boolean,
): void {
  const skillName = path.posix.basename(selection.path);
  const canonicalPath = path.join(projectRoot, ".agents", "skills", skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", skillName);
  output(`Preview: reconcile Skill ${JSON.stringify(skillName)} from ${source.id} (destination determined by safe inspection)`);
  output(`  scope: ${scope}; hosts: ${selection.hosts.join(",")}; version policy: ${formatVersionPolicy(selection.version)}`);
  if (inspection) {
    output(`  target: ${inspection.targetPath}`);
    if (inspection.collision) {
      output(`  COLLISION: ${inspection.collision.path} (${inspection.collision.reason})`);
      if (overwrite && confirmed) {
        output("  collision handling: target will be replaced because --overwrite --yes was supplied");
        output(`  overwrite backup: old Skill will be moved to a retained backup at ${backupPreviewPath(inspection.targetPath)} (generated at transaction time; never pruned automatically)`);
      } else if (overwrite) {
        output("  collision handling: fail-closed; no path will be changed without --yes; rerun with --overwrite --yes to replace the target");
        output(`  if confirmed: old Skill would be moved to a retained backup at ${backupPreviewPath(inspection.targetPath)}`);
      } else {
        output("  collision handling: fail-closed; no path will be changed; explicit overwrite requires --overwrite --yes");
      }
    } else if (inspection.locations.some((location) => location.status === "identical")) {
      output("  collision status: existing content is identical and can be adopted without replacement");
    } else {
      output("  collision status: target is absent and will be created");
    }
  }
  output(confirmed
    ? "  confirmation: --yes supplied; changes remain subject to final safety checks"
    : "  confirmation: no --yes supplied; zero files or installation state will be changed");
  output("  intended filesystem changes:");
  if (inspection?.collision && overwrite) {
    output(`    replace the colliding target at ${inspection.targetPath}, retain a backup of the existing Skill at ${backupPreviewPath(inspection.targetPath)}, and install the selected source files`);
  } else {
    output("    reconcile the selected source files below: adopt identical files, create missing files, and refuse conflicts");
  }
  output("  selected source files:");
  for (const file of files) {
    const action = inspection?.collision && overwrite ? "install into the replacement target" : "adopt if identical, create if missing";
    output(`    ${file.path} (${file.content.byteLength} bytes${file.executable ? ", executable" : ""}; ${action})`);
  }
  output(`  possible ${scope} locations:`);
  output(`    ${canonicalPath} (canonical Host location; safe inspection determines whether this is used)`);
  if (selection.hosts.includes("claude")) {
    output(`    ${claudePath} (Claude Host location; fresh install exposes the canonical location by symlink with --yes)`);
  }
  if (method) {
    const cwd = path.resolve(projectRoot, method.cwd ?? ".");
    output(`  run external method: argv=${JSON.stringify(method.argv)} executable=${JSON.stringify(method.argv[0])} args=${JSON.stringify(method.argv.slice(1))} cwd=${JSON.stringify(cwd)}`);
  }
}

function backupPreviewPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), ".agent-depot-backup-<generated-suffix>");
}

function assertNoManagedInstallationOverlap(
  managed: readonly ProjectSkillSelection[],
  selection: ProjectSkillSelection,
  inspection: ProjectSkillInstallationInspection,
  projectRoot: string,
  overwrite: boolean,
): readonly string[] {
  const protectedPaths = managed
    .filter((candidate) => !sameSelectionIdentity(candidate, selection))
    .flatMap((candidate) => candidate.installation?.path === undefined
      ? []
      : [path.resolve(projectRoot, ...candidate.installation.path.split("/"))]);
  if (!overwrite) return Object.freeze(protectedPaths);
  const conflicting = protectedPaths.find((candidate) => pathsOverlap(candidate, inspection.targetPath));
  if (conflicting !== undefined) {
    throw new CliUsageError(
      `Cannot overwrite ${JSON.stringify(inspection.targetPath)} because it overlaps the managed installation ${JSON.stringify(conflicting)} belonging to another Source/Skill selection; no path was changed.`,
    );
  }
  return Object.freeze(protectedPaths);
}

function sameSelectionIdentity(left: ProjectSkillSelection, right: ProjectSkillSelection): boolean {
  return JSON.stringify([left.source, left.path]) === JSON.stringify([right.source, right.path]);
}

function assertManagedInstallationRecordsUnchanged(
  expected: readonly ProjectSkillSelection[],
  actual: readonly ProjectSkillSelection[],
): void {
  const expectedKey = expected.map((selection) => JSON.stringify(selection)).sort().join("\n");
  const actualKey = actual.map((selection) => JSON.stringify(selection)).sort().join("\n");
  if (expectedKey !== actualKey) {
    throw new Error("Managed Skill installation records changed before deletion; no path was removed");
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

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  const reverse = path.relative(path.resolve(right), path.resolve(left));
  return relative === "" || reverse === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
    (!reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse));
}

function rejectInstallationCollision(
  inspection: ProjectSkillInstallationInspection,
  overwrite: boolean,
): void {
  if (!inspection.collision) return;
  const detail = `Cannot install because ${JSON.stringify(inspection.collision.path)} has a ${inspection.collision.reason} collision; no path was changed.`;
  if (inspection.collision.reason !== "missing-file" && inspection.collision.reason !== "extra-file" && inspection.collision.reason !== "content-mismatch") {
    throw new CliUsageError(`${detail} Unsafe targets cannot be overwritten.`);
  }
  if (overwrite) {
    return;
  }
  throw new CliUsageError(`${detail} Explicit overwrite requires --overwrite --yes.`);
}

function formatVersionPolicy(version: VersionPolicy): string {
  return version.policy === "latest" ? "latest" : `fixed:${version.version}`;
}

function selectionWithInstallation(
  selection: ProjectSkillSelection,
  result: ProjectSkillInstallationResult,
  projectRoot: string,
): ProjectSkillSelection {
  return parseProjectManifest({
    version: 1,
    skills: [{
      ...selection,
      installation: {
        path: relativeProjectPath(projectRoot, result.canonicalPath),
        adopted: result.adopted,
        ...(result.resolvedVersion === undefined ? {} : { resolvedVersion: result.resolvedVersion }),
        baseline: result.baseline,
      },
    }],
  }).skills[0]!;
}

function relativeProjectPath(projectRoot: string, candidate: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Installed Skill location escapes the project root: ${candidate}`);
  }
  return relative.split(path.sep).join("/");
}

function outputInstallationResult(
  result: ProjectSkillInstallationResult,
  projectRoot: string,
  output: (line: string) => void,
): void {
  const locations = result.adopted
    ? result.adoptedPaths
    : [result.canonicalPath];
  const rendered = locations.map((location) => relativeProjectPath(projectRoot, location)).join(", ");
  output(`${result.adopted ? "Adopted" : "Installed"} Skill ${JSON.stringify(result.skillName)} at ${rendered}`);
  if (result.backupPath !== undefined) {
    output(`  Persistent backup retained at ${result.backupPath}`);
  }
}

async function installOne(
  selection: ProjectSkillSelection,
  source: Source,
  sourceAccess: ProjectSkillTreeAccess,
  projectRoot: string,
  dependencies: CliDependencies,
  method: SourceInstallationMethod | undefined,
  portableV1: boolean,
  files: readonly SkillTreeFile[],
  resolvedVersion: ResolvedVersionEvidence | undefined,
  confirmAdditionalHostExposure: boolean,
  overwrite: boolean,
  inspection?: ProjectSkillInstallationInspection,
  protectedPaths: readonly string[] = [],
): Promise<ProjectSkillInstallationTransaction> {
  return installProjectSkillTransaction({
    selection,
    source,
    previewTree: files,
    portableV1,
    resolvedVersion,
    confirmAdditionalHostExposure,
    overwrite,
    ...(inspection === undefined ? {} : { inspection }),
    protectedPaths,
  }, {
    projectRoot,
    sourceAccess,
    ...dependencies.installationOptions,
  });
}

async function executeOrRejectMethod(
  item: ResolvedManifestSelection,
  operations: SourceOperations,
  projectRoot: string,
): Promise<void> {
  if (!item.method) {
    return;
  }
  const executor = operations.executeInstallationMethod ?? executeSourceInstallationMethod;
  await executor(item.method, {
    source: item.source,
    skillPath: item.selection.path,
    projectRoot,
  });
}

function externalMethodFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `External installation method failed after installation and manifest persistence; ` +
    `installed files were retained because method side effects cannot be rolled back: ${detail}`,
  );
}

async function rollbackTransactions(
  transactions: readonly ProjectSkillInstallationTransaction[],
  original: unknown,
): Promise<never> {
  const rollbackErrors: string[] = [];
  for (const transaction of [...transactions].reverse()) {
    try {
      await transaction.rollback();
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (rollbackErrors.length > 0) {
    const message = original instanceof Error ? original.message : String(original);
    throw new Error(`${message}; batch rollback failed: ${rollbackErrors.join("; ")}`);
  }
  throw original;
}

function defaultProjectSkillTreeAccess(): ProjectSkillTreeAccess {
  const access = createSourceContentAccess();
  if (!access.readSkillTree) {
    throw new Error("Configured Source content access cannot read complete Skill trees");
  }
  return {
    readSkillTree: (source, skillPath) => access.readSkillTree!(source, skillPath),
    ...(access.readSkillTreeSnapshot === undefined
      ? {}
      : { readSkillTreeSnapshot: (source: Source, skillPath: string) => access.readSkillTreeSnapshot!(source, skillPath) }),
  };
}

function projectSourceFromSource(source: Source, ref: string | undefined, version: VersionPolicy): ProjectSource {
  if (source.kind === "builtin") {
    if (ref !== undefined) {
      throw new CliUsageError("The built-in Source does not support --ref; its version follows the Agent Depot package");
    }
    return { kind: "builtin", id: source.id };
  }
  const selectedRef = ref ?? (version.policy === "fixed" ? version.version : source.ref);
  return { kind: "external", url: source.url, ...(selectedRef === undefined ? {} : { ref: selectedRef }) };
}

function requireConfirmation(confirmed: boolean, message: string): void {
  if (!confirmed) {
    throw new CliUsageError(message);
  }
}

function formatSource(source: Source): string {
  if (source.kind === "builtin") {
    return `${source.id}\tbuiltin\t${source.name}\tread-only`;
  }
  return `${source.id}\tgit\t${source.url}`;
}

function formatCandidate(candidate: SkillCandidate): string {
  const description = candidate.description.replace(/[\r\n]+/gu, "\\n");
  return `Candidate: ${candidate.sourceId}\t${candidate.path}\t${candidate.name}\t${description}`;
}

function formatDiscoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown discovery error";
  if (error instanceof SourceNotFoundError) {
    return `${message}. Run \`agent-depot source list\` and pass a registered Source ID`;
  }
  if (message.startsWith("Git Source mirror is not available:")) {
    return `${message}. Refresh the selected Git Source with \`agent-depot source refresh <source-id> --yes\` before discovering`;
  }
  return message;
}

async function findSource(operations: SourceOperations, sourceId: string): Promise<Source> {
  const source = (await operations.listSources()).find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new SourceNotFoundError(sourceId);
  }
  return source;
}

function requireArgumentCount(values: readonly string[], expected: number, usage: string): void {
  if (values.length !== expected) {
    throw new CliUsageError(`Usage: agent-depot ${usage}`);
  }
}

function requireSourceIds(sourceIds: readonly string[]): void {
  if (sourceIds.length === 0) {
    throw new CliUsageError(DISCOVER_USAGE);
  }
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
