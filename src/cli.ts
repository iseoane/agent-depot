#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { pathsOverlap } from "./path-safety.js";
import { skillTreeBaseline, type SkillCandidate } from "./skill-discovery.js";
import {
  BuiltInSourceError,
  createSourceOperations,
  resolveProjectSource,
  SourceMetadataError,
  SourceNotFoundError,
  type Source,
  type SourceOperations,
  type UserGlobalSkillMigration,
} from "./sources.js";
import {
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  PROJECT_HOSTS,
  type ProjectHost,
  type ProjectManifest,
  type ProjectSkillSelection,
  type ProjectSource,
  type VersionPolicy,
} from "./project-manifest.js";
import {
  inspectProjectSkillInstallation,
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
import {
  assertManagedInstallationRecordsUnchanged,
  executeSkillRemoval,
  inspectSkillRemovals,
  planSkillRemoval,
  describeSkillRemoval,
  recheckSkillRemoval,
  removeSkillFiles,
  removeSkillsAndRecords,
  selectUserGlobalSkills,
  SkillSelectionError,
  userGlobalRemovalOptions,
  type SkillRemovalPlan,
} from "./skill-removal.js";
import {
  defaultProjectSkillTreeAccess,
  executeOrRejectMethod,
  executeSingleInstall,
  externalMethodFailure,
  findSource,
  installOne,
  outputInstallationResult,
  outputInstallPreview,
  outputSingleInstallPreview,
  planSingleInstall,
  refreshResolvedSource,
  rejectInstallationCollision,
  resolveSelection,
  rollbackTransactions,
  type ResolvedManifestSelection,
} from "./skill-install.js";
import { CliUsageError } from "./usage-error.js";
import { applyUpdateBatch, previewSkillUpdate, relativeProjectPath, selectionWithInstallation } from "./skill-update.js";
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
  /** Test/embedding seam for the interactive TUI; defaults to the Ink renderer. */
  readonly renderTui?: (operations: SourceOperations) => Promise<void>;
  /** Test seam: whether stdin supports raw-mode keyboard input; defaults to the real stdin. */
  readonly isInteractive?: () => boolean;
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
  "  agent-depot update apply --scope <project|user-global> (--all | --skill <id|path>...) [--yes] [--confirm-path <relative-path>...]",
  "  agent-depot skill remove <id|path>... [--yes]",
  "  agent-depot uninstall [--skills] [--unmanaged-skill <exact-global-path>...] [--data] [--cli] [--yes]",
  "  agent-depot tui",
].join("\n");
const INSTALL_USAGE = "Usage: agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--overwrite --yes] [--confirm-additional-host]";
const DISCOVER_USAGE = "Usage: agent-depot discover <source-id> [source-id...]\nSelect at least one Source ID explicitly; run `agent-depot source list` to see registered Sources";
const REMOVE_SOURCE_USAGE = "Usage: agent-depot source remove <id> [--skill <id|path>...] [--all] [--yes]";
const MIGRATE_SOURCE_USAGE = "Usage: agent-depot source migrate <old-id> <new-id> (--skill <path>... | --all) [--yes]";
const SKILL_REMOVE_USAGE = "Usage: agent-depot skill remove <id|path>... [--yes]";
const UNINSTALL_USAGE = "Usage: agent-depot uninstall [--skills] [--unmanaged-skill <exact-global-path>...] [--data] [--cli] [--yes]";

interface CommandContext {
  readonly operations: SourceOperations;
  readonly dependencies: CliDependencies;
  readonly output: (line: string) => void;
}

type CommandHandler = (values: readonly string[], context: CommandContext) => Promise<number>;
type SourceSubcommandHandler = (values: readonly string[], context: CommandContext) => Promise<void>;

const SOURCE_SUBCOMMANDS = new Map<string, SourceSubcommandHandler>([
  ["list", async (values, { operations, output }) => {
    requireArgumentCount(values, 0, "source list");
    for (const source of await operations.listSources()) {
      output(formatSource(source));
    }
  }],
  ["add", async (values, { operations, output }) => {
    requireArgumentCount(values, 1, "source add <url>");
    const source = await operations.addGitSource(values[0]);
    output(`Added Git Source: ${source.id}\t${source.url}`);
  }],
  ["refresh", runSourceRefresh],
  ["remove", (values, { operations, dependencies, output }) => runSourceRemoval(values, operations, dependencies, output)],
  ["migrate", (values, { operations, dependencies, output }) => runSourceMigration(values, operations, dependencies, output)],
]);

const COMMANDS = new Map<string, CommandHandler>([
  ["install", async (values, { operations, dependencies, output }) => {
    await runInstall(values, operations, dependencies, output);
    return 0;
  }],
  ["update", (values, { operations, dependencies, output }) => runUpdate(values, operations, dependencies, output)],
  ["skill", async (values, { operations, dependencies, output }) => {
    if (values[0] !== "remove") throw new CliUsageError(USAGE);
    await runSkillRemoval(values.slice(1), operations, dependencies, output);
    return 0;
  }],
  ["uninstall", async (values, { operations, dependencies, output }) => {
    await runUninstall(values, operations, dependencies, output);
    return 0;
  }],
  ["discover", async (values, { operations, output }) => {
    requireSourceIds(values);
    const discoverSkills = operations.discoverSkills;
    if (!discoverSkills) {
      throw new CliUsageError("Discovery is unavailable in the configured Source operations");
    }
    let candidates: readonly SkillCandidate[];
    try {
      candidates = await discoverSkills.call(operations, values);
    } catch (error) {
      throw new Error(formatDiscoveryError(error));
    }
    for (const candidate of candidates) {
      output(formatCandidate(candidate));
    }
    return 0;
  }],
  ["tui", async (_values, { operations, dependencies }) => {
    const isInteractive = dependencies.isInteractive ?? (() => process.stdin.isTTY === true);
    if (!isInteractive()) {
      throw new Error("agent-depot tui requires an interactive terminal");
    }
    // Loaded lazily so non-interactive commands never import Ink/React.
    const renderTui = dependencies.renderTui ?? (await import("./tui/render.js")).renderTui;
    await renderTui(operations);
    return 0;
  }],
  ["source", async (values, context) => {
    const subcommand = SOURCE_SUBCOMMANDS.get(values[0] ?? "");
    if (!subcommand) {
      throw new CliUsageError(USAGE);
    }
    await subcommand(values.slice(1), context);
    return 0;
  }],
]);

async function runSourceRefresh(
  values: readonly string[],
  { operations, output }: CommandContext,
): Promise<void> {
  if (values.length < 1 || values.length > 2 || (values.length === 2 && values[1] !== "--yes")) {
    throw new CliUsageError("Usage: agent-depot source refresh <id> [--yes]");
  }
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

/** Runs the CLI application and returns a process exit code. */
export async function runCli(argv: readonly string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.stdout ?? ((line: string) => console.log(line));
  const errorOutput = dependencies.stderr ?? ((line: string) => console.error(line));
  const operations = dependencies.operations ?? createSourceOperations({ homeDirectory: dependencies.homeDirectory });

  try {
    const command = COMMANDS.get(argv[0] ?? "");
    if (!command) {
      throw new CliUsageError(USAGE);
    }
    return await command(argv.slice(1), { operations, dependencies, output });
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
  const removalOptions = userGlobalRemovalOptions(path.resolve(dependencies.homeDirectory ?? homedir()), dependencies.installationOptions);

  output(`Preview: remove Git Source ${source.id} from ${source.url}`);
  output(`Dependent user-global Skills (${dependent.length}):`);
  for (const [index, selection] of dependent.entries()) {
    const location = selection.installation?.path ?? "missing installation location";
    output(`  [${index}] ${selection.path} -> ${location}${selected.includes(selection) ? " (selected for removal)" : " (kept)"}`);
  }
  output("  Default: keep all dependent Skills tracked by default after Source removal");

  const plan = await inspectSkillRemovals(selected, removalOptions, (selection, inspection) => {
    for (const line of describeSkillRemoval(selection, inspection, "Skill ")) output(line);
  });

  assertNoOverlappingProjectSkillRemovalTargets(plan.inspections);
  requireConfirmation(options.confirmed, "Removal not confirmed; rerun with --yes after reviewing every Source and Skill preview");
  // Recheck every selected target before deleting the first one. A changed later
  // target must never result in a partially removed batch.
  const rechecked = await recheckSkillRemoval(plan, removalOptions);
  await removeSkillFiles(plan, rechecked, removalOptions);
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
  assertReplacementSnapshot(selection, snapshot);
  const contentMatches = selection.installation?.baseline !== undefined && snapshot !== undefined &&
    selection.installation.baseline.digest === skillTreeBaseline(snapshot.files).digest;
  const source = selection.version.policy === "fixed"
    ? { kind: "external" as const, url: newSource.url, ref: selection.version.version }
    : { kind: "external" as const, url: newSource.url };
  const installation = selection.installation === undefined
    ? undefined
    : {
      path: selection.installation.path,
      adopted: selection.installation.adopted,
      ...(selection.installation.baseline === undefined ? {} : { baseline: selection.installation.baseline }),
      ...(contentMatches && snapshot?.resolvedVersion !== undefined ? { resolvedVersion: snapshot.resolvedVersion } : {}),
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

function assertReplacementSnapshot(
  selection: ProjectSkillSelection,
  snapshot: Awaited<ReturnType<NonNullable<SourceOperations["readSkillTreeSnapshot"]>>> | undefined,
): void {
  if (snapshot !== undefined && !snapshot.files.some((file) => file.path === `${selection.path}/SKILL.md`)) {
    throw new Error(`Replacement Source does not contain selected Skill ${JSON.stringify(selection.path)}`);
  }
  if (selection.version.policy === "fixed" &&
    (snapshot?.resolvedVersion?.kind !== "git-commit" || snapshot.resolvedVersion.commit !== selection.version.version)) {
    throw new Error(`Cannot migrate fixed Skill ${JSON.stringify(selection.path)} without matching version evidence from the replacement Source`);
  }
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

async function runSkillRemoval(
  argv: readonly string[],
  operations: SourceOperations,
  dependencies: CliDependencies,
  output: (line: string) => void,
): Promise<void> {
  const requested: string[] = [];
  let confirmed = false;
  for (const argument of argv) {
    if (argument === "--yes") {
      confirmed = true;
    } else if (argument.startsWith("--")) {
      throw new CliUsageError(SKILL_REMOVE_USAGE);
    } else {
      requested.push(argument);
    }
  }
  if (requested.length === 0) throw new CliUsageError(SKILL_REMOVE_USAGE);
  if (!operations.listUserGlobalInstallations || !operations.removeUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot remove user-global Skills");
  }

  const installations = await operations.listUserGlobalInstallations();
  let selected: readonly ProjectSkillSelection[];
  try {
    selected = selectUserGlobalSkills(installations, requested);
  } catch (error) {
    if (error instanceof SkillSelectionError) throw new CliUsageError(error.message);
    throw error;
  }
  const removalOptions = userGlobalRemovalOptions(path.resolve(dependencies.homeDirectory ?? homedir()), dependencies.installationOptions);

  output(`Preview: remove ${selected.length} user-global Skill${selected.length === 1 ? "" : "s"}`);
  const plan = await planSkillRemoval(selected, removalOptions);
  for (const line of plan.preview) output(line);
  output("  Installation records are reconciled after each successful Skill removal");
  requireConfirmation(confirmed, "Removal not confirmed; rerun with --yes after reviewing every Skill preview");
  await executeSkillRemoval(plan, operations, removalOptions, installations);
  output(`Removed ${selected.length} user-global Skill${selected.length === 1 ? "" : "s"}`);
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
): Promise<SkillRemovalPlan> {
  if (!options.skills) {
    output("Managed Skills: preserve (not selected)");
    return { selections: [], inspections: [] };
  }
  output(`Managed Skills (${installations.length}):`);
  const plan = await inspectSkillRemovals(installations, removalOptions, (selection, inspection) => {
    for (const line of describeSkillRemoval(selection, inspection, "")) output(line);
  });
  output("  Installation records are reconciled after each successful Skill removal");
  return plan;
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
      if (managedInspection.paths.some((managedPath) => pathsOverlap(path.resolve(managedPath), path.resolve(unmanagedInspection.path)))) {
        throw new Error(message(unmanagedInspection.path));
      }
    }
  }
}

interface UninstallRemovalContext {
  readonly operations: SourceOperations;
  readonly homeDirectory: string;
  readonly removalOptions: ProjectInstallationOptions;
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
  const removalOptions = userGlobalRemovalOptions(homeDirectory, dependencies.installationOptions);
  const context: UninstallRemovalContext = { operations, homeDirectory, removalOptions };

  output("Uninstall preview (scope: user-global only)");
  const managedPlan = await previewManagedUninstall(options, selectedInstallations, removalOptions, output);
  const inspections = managedPlan.inspections;
  const unmanagedInspections = await previewUnmanagedUninstall(options, homeDirectory, selectedInstallations, output);
  outputDataAndCliUninstallPreview(options, output);

  assertNoOverlappingProjectSkillRemovalTargets(inspections);
  assertNoOverlappingUserGlobalSkillRemovals(unmanagedInspections);
  assertNoManagedUnmanagedOverlap(inspections, unmanagedInspections, (unmanagedPath) =>
    `Cannot remove unmanaged Skill ${JSON.stringify(unmanagedPath)} because it overlaps a selected managed Skill target; no path was changed`);
  if (options.skills || options.unmanagedSkills.length > 0 || options.data) {
    requireConfirmation(options.confirmed, "Uninstall not confirmed; rerun with --yes after reviewing every user-global deletion preview");
  }

  const managedRechecked = await recheckSkillRemoval(managedPlan, removalOptions);
  const rechecked = managedRechecked.inspections;
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
    ? await removeSkillsAndRecords(managedPlan, managedRechecked, operations, removalOptions, selectedInstallations)
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
  /** Exact relative non-canonical project paths the user confirmed with --confirm-path. */
  readonly confirmedPaths: readonly string[];
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
  const installed = manifestStore
    ? (await manifestStore.load()).skills
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

  const installationFileSystem = dependencies.installationOptions?.fileSystem;
  const context = {
    projectRoot,
    scope: options.scope,
    sourceAccess,
    sourceOperations: operations,
    trackedInstallationPaths: installed.flatMap((selection) => selection.installation === undefined ? [] : [selection.installation.path]),
    ...(manifestStore === undefined ? {} : { projectManifestStore: manifestStore }),
    ...(installationFileSystem === undefined ? {} : { installationFileSystem }),
  };
  const selected = selectUpdateCandidates(assessment, options);
  const { failures: previewFailures, nonCanonicalPaths } = await previewUpdateCandidates(selected, context, options.scope, output);

  requireConfirmation(options.confirmed, "Update not confirmed; rerun with --yes after reviewing every candidate preview");
  requireNonCanonicalPathConfirmations(nonCanonicalPaths, options.confirmedPaths);
  const result = await applyUpdateBatch(selected, {
    ...context,
    // The callback is invoked independently for every candidate. In particular,
    // a modified installation is never overwritten unless this invocation was
    // explicitly confirmed with --yes.
    confirm: async (plan) => ({
      overwriteModifiedInstallation: options.confirmed,
      externalMethod: options.confirmed,
      ...(options.confirmed && plan.nonCanonicalPath !== undefined && options.confirmedPaths.includes(relativeProjectPath(projectRoot, plan.nonCanonicalPath))
        ? { nonCanonicalPath: plan.nonCanonicalPath }
        : {}),
    }),
  });

  for (const failure of previewFailures) {
    if (!result.failed.some((item) => item.id === failure.id)) {
      output(`Preview failure was not selected for application: ${JSON.stringify(failure.id)}`);
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

function selectUpdateCandidates(
  assessment: Parameters<typeof selectUpdateBatch>[0],
  options: UpdateOptions,
): readonly UpdateBatchAssessmentItem[] {
  const requested = options.all
    ? "all" as const
    : resolveUpdateSelectionIds(assessment, options.requested);
  try {
    return selectUpdateBatch(assessment, requested);
  } catch (error) {
    if (error instanceof UpdateBatchSelectionError) throw new CliUsageError(error.message);
    throw error;
  }
}

interface UpdatePreviewOutcome {
  readonly failures: readonly UpdateBatchAssessmentItem[];
  /** Relative non-canonical project paths that need --confirm-path, in preview order. */
  readonly nonCanonicalPaths: readonly string[];
}

async function previewUpdateCandidates(
  selected: readonly UpdateBatchAssessmentItem[],
  context: Parameters<typeof previewSkillUpdate>[1],
  scope: UpdateOptions["scope"],
  output: (line: string) => void,
): Promise<UpdatePreviewOutcome> {
  const failures: UpdateBatchAssessmentItem[] = [];
  const nonCanonicalPaths: string[] = [];
  for (const item of selected) {
    try {
      const plan = await previewSkillUpdate(item, context);
      if (plan.nonCanonicalPath !== undefined) nonCanonicalPaths.push(relativeProjectPath(context.projectRoot, plan.nonCanonicalPath));
      outputUpdatePreview(plan, scope, output, context.projectRoot);
    } catch (error) {
      failures.push(item);
      output(`Preview failed for ${JSON.stringify(item.id)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { failures, nonCanonicalPaths };
}

/**
 * `--yes` alone never confirms a repository-controlled non-canonical location:
 * every pending path needs its own exact `--confirm-path`, and a value that
 * matches no pending path is an error rather than silently ignored.
 */
function requireNonCanonicalPathConfirmations(pending: readonly string[], confirmedPaths: readonly string[]): void {
  const unmatched = confirmedPaths.filter((value) => !pending.includes(value));
  if (unmatched.length > 0) {
    const shown = pending.length === 0 ? "none" : pending.map((value) => JSON.stringify(value)).join(", ");
    throw new CliUsageError(`--confirm-path ${unmatched.map((value) => JSON.stringify(value)).join(", ")} does not match any pending non-canonical location (pending: ${shown}); no path was changed`);
  }
  const missing = pending.filter((value) => !confirmedPaths.includes(value));
  if (missing.length > 0) {
    const flags = missing.map((value) => `--confirm-path ${value}`).join(" ");
    throw new CliUsageError(`Non-canonical location ${missing.map((value) => JSON.stringify(value)).join(", ")} needs explicit path confirmation; --yes alone is not enough. Rerun with ${flags}; no path was changed`);
  }
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
  const confirmedPaths: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--scope":
        scope = requireOptionValue(argv, ++index, "--scope");
        break;
      case "--confirm-path":
        confirmedPaths.push(normalizeConfirmedPath(requireOptionValue(argv, ++index, "--confirm-path")));
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
  if (action === "check" && (all || requested.length > 0 || confirmed || confirmedPaths.length > 0)) {
    throw new CliUsageError("update check only accepts --scope; use update apply to select and apply updates");
  }
  if (action === "apply" && (all === (requested.length > 0))) {
    throw new CliUsageError("update apply requires exactly one selection mode: --all or one or more --skill values");
  }
  if (scope === "user-global" && confirmedPaths.length > 0) {
    throw new CliUsageError("--confirm-path only applies to --scope project");
  }
  return {
    action,
    scope: scope as "project" | "user-global",
    all,
    requested: Object.freeze(requested),
    confirmed,
    confirmedPaths: Object.freeze(confirmedPaths),
  };
}

/** Normalizes a --confirm-path value like the relative path shown in the preview. */
function normalizeConfirmedPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
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
  projectRoot: string,
): void {
  output(`Preview: update Skill ${JSON.stringify(plan.selection.path)} from ${plan.source.id} (scope: ${scope})`);
  output(`  target: ${plan.target}`);
  if (plan.nonCanonicalPath !== undefined) {
    const relative = relativeProjectPath(projectRoot, plan.nonCanonicalPath);
    output(`  WARNING: non-canonical location ${JSON.stringify(relative)} (outside .agents/skills and .claude/skills); --yes together with --confirm-path ${relative} explicitly confirms replacing this exact path`);
  }
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

  const context: ProjectInstallContext = { options, operations, dependencies, sourceAccess, output, projectRoot, manifestStore };
  if (options.fromManifest) {
    await runManifestInstall(context);
    return;
  }
  await runSingleProjectInstall(context);
}

interface ProjectInstallContext {
  readonly options: InstallOptions;
  readonly operations: SourceOperations;
  readonly dependencies: CliDependencies;
  readonly sourceAccess: ProjectSkillTreeAccess;
  readonly output: (line: string) => void;
  readonly projectRoot: string;
  readonly manifestStore: ProjectManifestStore;
}

async function runManifestInstall(context: ProjectInstallContext): Promise<void> {
  const { options, operations, dependencies, sourceAccess, output, projectRoot, manifestStore } = context;
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
}

async function runSingleProjectInstall(context: ProjectInstallContext): Promise<void> {
  const { options, operations, dependencies, sourceAccess, output, projectRoot, manifestStore } = context;
  if (!options.sourceId || !options.skillPath || !options.version || options.hosts.length === 0) {
    throw new CliUsageError(INSTALL_USAGE);
  }
  const existing = await manifestStore.load();
  const plan = await planSingleInstall(
    { ...options, scope: "project", sourceId: options.sourceId, skillPath: options.skillPath, version: options.version },
    { operations, sourceAccess, environment: dependencies, root: projectRoot, existing: existing.skills, recordedIn: manifestStore.path },
  );
  outputSingleInstallPreview(plan, output);
  requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");
  await executeSingleInstall(plan, async (record) => {
    await manifestStore.save(parseProjectManifest({ version: 1, skills: [...existing.skills, record] }));
  }, output);
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
  const { listUserGlobalInstallations, addUserGlobalInstallation } = operations;
  if (!listUserGlobalInstallations || !addUserGlobalInstallation) {
    throw new Error("Configured Source operations cannot manage user-global installation state");
  }
  const homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
  const plan = await planSingleInstall(
    { ...options, scope: "user-global", sourceId: options.sourceId, skillPath: options.skillPath, version: options.version },
    { operations, sourceAccess, environment: dependencies, root: homeDirectory, existing: await listUserGlobalInstallations.call(operations), recordedIn: "user-global state" },
  );
  outputSingleInstallPreview(plan, output);
  requireConfirmation(options.confirmed, "Installation not confirmed; rerun with --yes to continue");
  await executeSingleInstall(plan, (record) => addUserGlobalInstallation.call(operations, record), output);
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
interface InstallDraft {
  scope?: string;
  sourceId?: string;
  skillPath?: string;
  versionValue?: string;
  ref?: string;
  method?: unknown;
  fromManifest: boolean;
  portableV1: boolean;
  confirmed: boolean;
  overwrite: boolean;
  confirmAdditionalHostExposure: boolean;
  readonly hosts: ProjectHost[];
}

const INSTALL_VALUE_OPTIONS = new Map<string, (draft: InstallDraft, value: string) => void>([
  ["--scope", (draft, value) => { draft.scope = value; }],
  ["--source", (draft, value) => { draft.sourceId = value; }],
  ["--skill", (draft, value) => { draft.skillPath = value; }],
  ["--host", (draft, value) => {
    for (const host of value.split(",")) {
      if (!PROJECT_HOSTS.includes(host as ProjectHost) || draft.hosts.includes(host as ProjectHost)) {
        throw new CliUsageError(`Unsupported or duplicate Host ${JSON.stringify(host)}`);
      }
      draft.hosts.push(host as ProjectHost);
    }
  }],
  ["--version", (draft, value) => { draft.versionValue = value; }],
  ["--ref", (draft, value) => { draft.ref = value; }],
  ["--method", (draft, value) => { draft.method = parseMethodOption(value); }],
]);

const INSTALL_FLAG_OPTIONS = new Map<string, (draft: InstallDraft) => void>([
  ["--manifest", (draft) => { draft.fromManifest = true; }],
  ["--portable-v1", (draft) => { draft.portableV1 = true; }],
  ["--yes", (draft) => { draft.confirmed = true; }],
  ["--overwrite", (draft) => { draft.overwrite = true; }],
  ["--confirm-additional-host", (draft) => { draft.confirmAdditionalHostExposure = true; }],
]);

function parseInstallOptions(argv: readonly string[]): InstallOptions {
  const draft: InstallDraft = {
    fromManifest: false,
    portableV1: false,
    confirmed: false,
    overwrite: false,
    confirmAdditionalHostExposure: false,
    hosts: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const applyValue = INSTALL_VALUE_OPTIONS.get(argument);
    const applyFlag = INSTALL_FLAG_OPTIONS.get(argument);
    if (applyValue) {
      applyValue(draft, requireOptionValue(argv, ++index, argument));
    } else if (applyFlag) {
      applyFlag(draft);
    } else {
      throw new CliUsageError(INSTALL_USAGE);
    }
  }
  return finalizeInstallOptions(draft);
}

function finalizeInstallOptions(draft: InstallDraft): InstallOptions {
  const { scope, sourceId, skillPath, versionValue, ref, method, fromManifest, hosts, overwrite } = draft;
  if (scope !== "project" && scope !== "user-global") {
    throw new CliUsageError("Installation scope must be explicit: use --scope project or --scope user-global");
  }
  const selectsSkill = sourceId !== undefined || skillPath !== undefined || ref !== undefined || hosts.length > 0;
  if (fromManifest) {
    if (scope !== "project") {
      throw new CliUsageError("--manifest is only supported with --scope project");
    }
    if (selectsSkill || versionValue !== undefined || method !== undefined || overwrite) {
      throw new CliUsageError("--manifest cannot be combined with --source, --skill, --host, --version, --ref, --method, or --overwrite");
    }
  } else if (versionValue === undefined) {
    throw new CliUsageError(selectsSkill ? "--version is required for a selected Skill" : INSTALL_USAGE);
  }
  return {
    scope,
    fromManifest,
    sourceId,
    skillPath,
    hosts: Object.freeze(hosts),
    version: versionValue === undefined ? undefined : parseVersionOption(versionValue),
    ref,
    method,
    portableV1: draft.portableV1,
    confirmed: draft.confirmed,
    overwrite,
    confirmAdditionalHostExposure: draft.confirmAdditionalHostExposure,
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

function assertUnmanagedInspectionUnchanged(
  expected: UserGlobalSkillRemovalInspection,
  actual: UserGlobalSkillRemovalInspection,
): void {
  if (expected.name !== actual.name || expected.path !== actual.path || expected.identity !== actual.identity || expected.digest !== actual.digest) {
    throw new Error(`The inspected unmanaged Skill changed before deletion: ${JSON.stringify(expected.path)}; no path was changed`);
  }
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
