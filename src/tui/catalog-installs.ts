import { homedir } from "node:os";
import path from "node:path";

import {
  defaultProjectManifestPath,
  parseProjectManifest,
  PROJECT_HOSTS,
  ProjectManifestStore,
  type ProjectHost,
  type ProjectSkillSelection,
  type ProjectSource,
  type VersionPolicy,
} from "../project-manifest.js";
import {
  defaultProjectSkillTreeAccess,
  executeSingleInstall,
  needsAdditionalHostExposure,
  outputSingleInstallPreview,
  planSingleInstall,
  type SingleInstallPlan,
} from "../skill-install.js";
import type { SkillCandidate } from "../skill-discovery.js";
import {
  executeHostAddition,
  executeHostRemoval,
  planHostAddition,
  planHostRemoval,
  type HostAdditionPlan,
  type HostRemovalPlan,
} from "../skill-hosts.js";
import {
  executeSkillRemoval,
  planSkillRemoval,
  SkillSelectionError,
  userGlobalRemovalOptions,
  type SkillRemovalPlan,
} from "../skill-removal.js";
import type { Source, SourceOperations } from "../sources.js";
import { scanUserGlobalSkillInventory } from "../user-global-skill-inventory.js";
import type { TuiEnvironment } from "./environment.js";

export type InstallScope = "project" | "user-global";

/** Installations known to the Catalog, plus the Sources used to match them to discovered Skills. */
export interface InstalledSkills {
  readonly global: readonly ProjectSkillSelection[];
  readonly project: readonly ProjectSkillSelection[];
  readonly sources: readonly Source[];
  /** Names of Skills that exist unmanaged on disk (directories or symlinks under the global roots). */
  readonly unmanagedNames: ReadonlySet<string>;
}

export const NO_INSTALLED: InstalledSkills = { global: [], project: [], sources: [], unmanagedNames: new Set() };

function homeOf(environment: TuiEnvironment): string {
  return path.resolve(environment.homeDirectory ?? homedir());
}

function manifestStoreOf(environment: TuiEnvironment): ProjectManifestStore {
  return environment.projectManifestStore ??
    new ProjectManifestStore(defaultProjectManifestPath(path.resolve(environment.projectRoot ?? process.cwd())));
}

/** Loads user-global and project installations; anything unavailable or unreadable yields no markers. */
export async function loadInstalledSkills(
  operations: SourceOperations,
  environment: TuiEnvironment,
): Promise<InstalledSkills> {
  const [global, project, sources] = await Promise.all([
    operations.listUserGlobalInstallations?.().catch(() => []) ?? [],
    manifestStoreOf(environment).load().then((manifest) => manifest.skills, () => []),
    operations.listSources().catch(() => []),
  ]);
  const unmanagedNames = await scanUserGlobalSkillInventory({ homeDirectory: homeOf(environment), managedInstallations: global }).then(
    (inventory) => new Set([...inventory.unmanaged, ...inventory.symlinks].map((entry) => entry.name)),
    () => new Set<string>(),
  );
  return { global, project, sources, unmanagedNames };
}

/** Whether an unmanaged copy with the Skill's directory name exists on disk (the name an install would use). */
export function hasUnmanagedCopy(skill: SkillCandidate, installed: InstalledSkills): boolean {
  return installed.unmanagedNames.has(path.posix.basename(skill.path));
}

function matchesSource(source: ProjectSource, sourceId: string, sources: readonly Source[]): boolean {
  if (source.kind === "builtin") return source.id === sourceId;
  if (!("url" in source)) return false;
  return sources.some((candidate) => candidate.kind === "git" && candidate.id === sourceId && candidate.url === source.url);
}

function recordsFor(records: readonly ProjectSkillSelection[], skill: SkillCandidate, sources: readonly Source[]) {
  return records.filter((record) => record.path === skill.path && matchesSource(record.source, skill.sourceId, sources));
}

/** Whether the Skill is installed user-global or in the project manifest (same Source and path). */
export function isInstalled(skill: SkillCandidate, installed: InstalledSkills): boolean {
  return [installed.global, installed.project].some((records) => recordsFor(records, skill, installed.sources).length > 0);
}

export interface InstallChoice {
  readonly hosts: readonly ProjectHost[];
  readonly scope: InstallScope;
  readonly version: VersionPolicy;
}

export interface PreparedInstall {
  readonly plan: SingleInstallPlan;
  readonly manifestStore?: ProjectManifestStore;
  readonly preview: readonly string[];
  readonly runsExternalCommand: boolean;
  /** Adopting an identical existing Skill needs a missing Host location added; needs its own confirmation. */
  readonly additionalHostExposure: boolean;
}

/** Plan step: refreshes the Source, resolves and inspects the install and renders the same preview the CLI prints. */
export async function prepareInstall(
  operations: SourceOperations,
  environment: TuiEnvironment,
  skill: SkillCandidate,
  choice: InstallChoice,
): Promise<PreparedInstall> {
  const request = {
    scope: choice.scope,
    sourceId: skill.sourceId,
    skillPath: skill.path,
    hosts: choice.hosts,
    version: choice.version,
    // Confirming the preview is the review the CLI asks for with --portable-v1.
    portableV1: true,
    // Planning with confirmed set refreshes a Git Source before resolving, so
    // the preview shows exactly what y installs (the CLI does this on --yes).
    confirmed: true,
    overwrite: false,
    confirmAdditionalHostExposure: false,
  };
  const sourceAccess = environment.sourceAccess ?? defaultProjectSkillTreeAccess();
  const base = { operations, sourceAccess, environment };
  let plan: SingleInstallPlan;
  let manifestStore: ProjectManifestStore | undefined;
  if (choice.scope === "user-global") {
    if (!operations.listUserGlobalInstallations || !operations.addUserGlobalInstallation) {
      throw new Error("Configured Source operations cannot manage user-global installation state");
    }
    plan = await planSingleInstall(request, {
      ...base,
      root: homeOf(environment),
      existing: await operations.listUserGlobalInstallations(),
      recordedIn: "user-global state",
    });
  } else {
    manifestStore = manifestStoreOf(environment);
    plan = await planSingleInstall(request, {
      ...base,
      root: path.resolve(environment.projectRoot ?? process.cwd()),
      existing: (await manifestStore.load()).skills,
      recordedIn: manifestStore.path,
    });
  }
  const lines: string[] = [];
  outputSingleInstallPreview(plan, (line) => lines.push(line));
  // The TUI confirms interactively, so the CLI's --yes wording does not apply.
  const preview = lines.filter((line) => !line.startsWith("  confirmation:"));
  const additionalHostExposure = needsAdditionalHostExposure(plan.inspection, choice.hosts);
  if (additionalHostExposure) {
    preview.push(
      "  ADDITIONAL HOST EXPOSURE: an identical Skill already exists; installing adds the missing Host location (equivalent to --confirm-additional-host) and needs a separate confirmation",
    );
  }
  return { plan, manifestStore, preview, runsExternalCommand: plan.resolved.method !== undefined, additionalHostExposure };
}

/** Execute step: installs and persists the record; returns the result lines. */
export async function runInstall(
  prepared: PreparedInstall,
  operations: SourceOperations,
  confirmAdditionalHostExposure = false,
): Promise<readonly string[]> {
  const lines: string[] = [];
  const { manifestStore } = prepared;
  const plan = confirmAdditionalHostExposure
    ? { ...prepared.plan, request: { ...prepared.plan.request, confirmAdditionalHostExposure: true } }
    : prepared.plan;
  const persist = manifestStore
    ? async (record: ProjectSkillSelection) => {
        // Read at persist time: a batch installs several Skills, and each record must keep the ones saved before it.
        const current = (await manifestStore.load()).skills;
        await manifestStore.save(parseProjectManifest({ version: 1, skills: [...current, record] }));
      }
    : (record: ProjectSkillSelection) => operations.addUserGlobalInstallation!(record);
  await executeSingleInstall(plan, persist, (line) => lines.push(line));
  return lines;
}

export type UninstallPreparation =
  | { readonly kind: "unsupported" | "not-installed" | "project-only" }
  | {
      readonly kind: "ready";
      readonly plan: SkillRemovalPlan & { readonly preview: readonly string[] };
      readonly installations: readonly ProjectSkillSelection[];
    };

/** Why a preparation that is not `ready` refuses, in the words the TUI shows. */
export const UNINSTALL_REFUSALS = {
  unsupported: "Uninstall is not supported by the configured operations",
  "not-installed": "Skill is not installed",
  "project-only": "Project uninstall is not supported",
} as const;

/** Plan step for removing the highlighted Skill's user-global installation. */
export async function prepareUninstall(
  operations: SourceOperations,
  environment: TuiEnvironment,
  skill: SkillCandidate,
  installed: InstalledSkills,
): Promise<UninstallPreparation> {
  if (!operations.listUserGlobalInstallations || !operations.removeUserGlobalInstallations) {
    return { kind: "unsupported" };
  }
  const installations = await operations.listUserGlobalInstallations();
  const matches = recordsFor(installations, skill, installed.sources);
  if (matches.length === 0) {
    return { kind: recordsFor(installed.project, skill, installed.sources).length > 0 ? "project-only" : "not-installed" };
  }
  const options = userGlobalRemovalOptions(homeOf(environment), environment.installationOptions);
  const record = matches[0]!;
  const plan = await planSkillRemoval([record], options);
  const scopeNote = `  removes the whole user-global installation, from hosts: ${record.hosts.join(", ")}`;
  return { kind: "ready", plan: { ...plan, preview: [...plan.preview, scopeNote] }, installations };
}

/** Execute step: rechecks the plan, then removes files and records. */
export async function runUninstall(
  prepared: Extract<UninstallPreparation, { kind: "ready" }>,
  operations: SourceOperations,
  environment: TuiEnvironment,
): Promise<void> {
  const options = userGlobalRemovalOptions(homeOf(environment), environment.installationOptions);
  await executeSkillRemoval(prepared.plan, operations, options, prepared.installations);
}

/** The user-global record of the Skill, when it is installed there. */
export function globalRecord(skill: SkillCandidate, installed: InstalledSkills): ProjectSkillSelection | undefined {
  return recordsFor(installed.global, skill, installed.sources)[0];
}

/** Hosts a user-global record does not serve yet, in checklist order. */
export function missingHosts(record: ProjectSkillSelection): readonly ProjectHost[] {
  return PROJECT_HOSTS.filter((host) => !record.hosts.includes(host));
}

export interface PreparedHostAddition {
  readonly plan: HostAdditionPlan;
  readonly installations: readonly ProjectSkillSelection[];
  readonly preview: readonly string[];
}

export interface PreparedHostRemoval {
  readonly plan: HostRemovalPlan;
  readonly installations: readonly ProjectSkillSelection[];
  readonly preview: readonly string[];
}

/** Reads the current records so a host change never acts on a stale checklist. */
async function currentGlobalRecord(
  operations: SourceOperations,
  skill: SkillCandidate,
  installed: InstalledSkills,
): Promise<{ readonly record: ProjectSkillSelection; readonly installations: readonly ProjectSkillSelection[] }> {
  if (!operations.listUserGlobalInstallations || !operations.updateUserGlobalInstallation || !operations.removeUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot manage user-global installation state");
  }
  const installations = await operations.listUserGlobalInstallations();
  const record = recordsFor(installations, skill, installed.sources)[0];
  if (!record) throw new Error("Skill is not installed");
  return { record, installations };
}

/** A selection problem is a normal message for the TUI, like any other failed step. */
function asMessage(error: unknown): never {
  throw error instanceof SkillSelectionError ? new Error(error.message) : error;
}

/** Plan step for exposing an installed user-global Skill to more hosts. */
export async function prepareHostAddition(
  operations: SourceOperations,
  environment: TuiEnvironment,
  skill: SkillCandidate,
  installed: InstalledSkills,
  hosts: readonly ProjectHost[],
): Promise<PreparedHostAddition> {
  const { record, installations } = await currentGlobalRecord(operations, skill, installed);
  const options = userGlobalRemovalOptions(homeOf(environment), environment.installationOptions);
  const plan = await planHostAddition(record, hosts, options).catch(asMessage);
  return { plan, installations, preview: plan.preview };
}

/** Execute step: the TUI's separate exposure confirmation stands in for `--confirm-additional-host`. */
export async function runHostAddition(
  prepared: PreparedHostAddition,
  operations: SourceOperations,
  environment: TuiEnvironment,
): Promise<string> {
  const options = userGlobalRemovalOptions(homeOf(environment), environment.installationOptions);
  await executeHostAddition(prepared.plan, operations, options, prepared.installations, true);
  return `Added hosts ${prepared.plan.hosts.join(", ")} to ${prepared.plan.selection.path}`;
}

/** Plan step for removing some hosts of a user-global Skill; removing all of them is a full removal. */
export async function prepareHostRemoval(
  operations: SourceOperations,
  environment: TuiEnvironment,
  skill: SkillCandidate,
  installed: InstalledSkills,
  hosts: readonly ProjectHost[],
): Promise<PreparedHostRemoval> {
  const { record, installations } = await currentGlobalRecord(operations, skill, installed);
  const options = userGlobalRemovalOptions(homeOf(environment), environment.installationOptions);
  const plan = await planHostRemoval(record, hosts, options).catch(asMessage);
  return { plan, installations, preview: plan.kind === "full" ? plan.plan.preview : plan.preview };
}

/** Execute step: rechecks, removes only the chosen hosts' locations, then reconciles the record. */
export async function runHostRemoval(
  prepared: PreparedHostRemoval,
  operations: SourceOperations,
  environment: TuiEnvironment,
  skill: SkillCandidate,
): Promise<string> {
  const options = userGlobalRemovalOptions(homeOf(environment), environment.installationOptions);
  await executeHostRemoval(prepared.plan, operations, options, prepared.installations);
  const { plan } = prepared;
  return plan.kind === "full"
    ? `Removed ${skill.name} (${skill.path})`
    : `Removed hosts ${plan.removed.join(", ")} from ${plan.selection.path}`;
}
