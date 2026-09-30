import { homedir } from "node:os";
import path from "node:path";

import {
  defaultProjectManifestPath,
  ProjectManifestStore,
  type ProjectHost,
  type ProjectSkillSelection,
  type ProjectSource,
  type VersionPolicy,
} from "../project-manifest.js";
import { formatVersionPolicy } from "../skill-install.js";
import type { SkillCandidate } from "../skill-discovery.js";
import { inspectSkillRemovals, userGlobalRemovalOptions } from "../skill-removal.js";
import {
  scanUserGlobalSkillInventory,
  type UserGlobalSkillInventoryEntry,
} from "../user-global-skill-inventory.js";
import type { Source, SourceOperations } from "../sources.js";
import { prepareInstall, type PreparedInstall } from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";

/** One installation as the Installations view shows it. */
export interface InstallationRow {
  readonly scope: "user-global" | "project";
  readonly selection: ProjectSkillSelection;
  /** Source label: the built-in id or the external URL with its ref. */
  readonly source: string;
  readonly policy: string;
  /** Installed version evidence, or `unknown` when none was recorded. */
  readonly installed: string;
  readonly adopted: boolean;
  /** Undefined when the installation could not be inspected. */
  readonly modified?: boolean;
}

export interface InstallationsData {
  /** Undefined when the configured operations cannot read user-global state. */
  readonly global?: readonly InstallationRow[];
  readonly project: readonly InstallationRow[];
  readonly projectError?: string;
  readonly unmanaged: readonly UserGlobalSkillInventoryEntry[];
  readonly sources: readonly Source[];
}

function homeOf(environment: TuiEnvironment): string {
  return path.resolve(environment.homeDirectory ?? homedir());
}

function projectRootOf(environment: TuiEnvironment): string {
  return path.resolve(environment.projectRoot ?? process.cwd());
}

function sourceLabel(source: ProjectSource): string {
  if (source.kind === "builtin") return source.id;
  return "url" in source ? `${source.url}${source.ref === undefined ? "" : `@${source.ref}`}` : source.path;
}

function installedVersion(selection: ProjectSkillSelection): string {
  const evidence = selection.installation?.resolvedVersion;
  if (!evidence) return "unknown";
  return evidence.kind === "builtin-package" ? evidence.version : evidence.commit.slice(0, 7);
}

async function toRow(
  scope: InstallationRow["scope"],
  selection: ProjectSkillSelection,
  inspectionOptions: Parameters<typeof inspectSkillRemovals>[1],
): Promise<InstallationRow> {
  const modified = await inspectSkillRemovals([selection], inspectionOptions).then(
    (plan) => plan.inspections[0]?.modified,
    () => undefined,
  );
  return {
    scope,
    selection,
    source: sourceLabel(selection.source),
    policy: formatVersionPolicy(selection.version),
    installed: installedVersion(selection),
    adopted: selection.installation?.adopted === true,
    ...(modified === undefined ? {} : { modified }),
  };
}

/** Loads both scopes and the unmanaged user-global inventory the CLI's `update check` uses. */
export async function loadInstallations(
  operations: SourceOperations,
  environment: TuiEnvironment,
): Promise<InstallationsData> {
  const home = homeOf(environment);
  const globalRecords = operations.listUserGlobalInstallations
    ? await operations.listUserGlobalInstallations()
    : undefined;
  const globalOptions = userGlobalRemovalOptions(home, environment.installationOptions);
  const global = globalRecords
    ? await Promise.all(globalRecords.map((record) => toRow("user-global", record, globalOptions)))
    : undefined;

  const store = environment.projectManifestStore ??
    new ProjectManifestStore(defaultProjectManifestPath(projectRootOf(environment)));
  let projectRecords: readonly ProjectSkillSelection[] = [];
  let projectError: string | undefined;
  try {
    projectRecords = (await store.load()).skills;
  } catch (error) {
    projectError = error instanceof Error ? error.message : String(error);
  }
  const projectOptions = {
    projectRoot: projectRootOf(environment),
    sourceAccess: { readSkillTree: async () => [] },
    ...environment.installationOptions,
  };
  const project = await Promise.all(projectRecords.map((record) => toRow("project", record, projectOptions)));

  const unmanaged = globalRecords
    ? (await scanUserGlobalSkillInventory({ homeDirectory: home, managedInstallations: globalRecords })).unmanaged
    : [];
  const sources = await operations.listSources().catch(() => []);
  return { global, project, ...(projectError === undefined ? {} : { projectError }), unmanaged, sources };
}

/** Source id of an installation's Source, when that Source is still registered. */
export function sourceIdOf(selection: ProjectSkillSelection, sources: readonly Source[]): string | undefined {
  const source = selection.source;
  if (source.kind === "builtin") return source.id;
  if (!("url" in source)) return undefined;
  return sources.find((candidate) => candidate.kind === "git" && candidate.url === source.url)?.id;
}

/** Source Skills whose directory name equals the unmanaged Skill's, across every registered Source. */
export async function findAdoptionCandidates(
  operations: SourceOperations,
  entry: UserGlobalSkillInventoryEntry,
): Promise<readonly SkillCandidate[]> {
  if (!operations.discoverSkills) throw new Error("Discovery is not supported by the configured operations");
  const ids = (await operations.listSources()).map((source) => source.id);
  return (await operations.discoverSkills(ids)).filter((skill) => path.posix.basename(skill.path) === entry.name);
}

/** Hosts that already read the unmanaged Skill's location, so adopting it exposes nothing new. */
export function defaultAdoptionHosts(entry: UserGlobalSkillInventoryEntry): readonly ProjectHost[] {
  return entry.host === "claude" ? ["claude"] : ["pi", "codex", "opencode"];
}

export type AdoptionVerdict =
  | { readonly adoptable: true }
  | { readonly adoptable: false; readonly reason: string };

/**
 * Adoption keeps the existing location, so it only applies when that exact
 * location's content is identical to the selected Source Skill (the CLI's rule).
 */
export function adoptionVerdict(prepared: PreparedInstall, entry: UserGlobalSkillInventoryEntry): AdoptionVerdict {
  const { inspection } = prepared.plan;
  const location = path.resolve(entry.path);
  const identical = inspection.locations.some(
    (candidate) => candidate.status === "identical" && path.resolve(candidate.path) === location,
  );
  if (identical) return { adoptable: true };
  const collision = inspection.collision ?? inspection.locations.find((candidate) => candidate.collision)?.collision;
  return {
    adoptable: false,
    reason: collision
      ? `Cannot adopt ${entry.path}: it does not match the selected Source Skill (${collision.reason} at ${collision.path}); nothing was changed`
      : `Cannot adopt ${entry.path}: no identical existing copy was found, so an install would create a new copy instead; nothing was changed`,
  };
}

export interface PreparedAdoption {
  readonly prepared: PreparedInstall;
  readonly verdict: AdoptionVerdict;
}

/** Plan step: the shared install plan (refreshing the Source) plus the adoption verdict. Changes nothing. */
export async function prepareAdoption(
  operations: SourceOperations,
  environment: TuiEnvironment,
  entry: UserGlobalSkillInventoryEntry,
  skill: SkillCandidate,
  choice: { readonly hosts: readonly ProjectHost[]; readonly version: VersionPolicy },
): Promise<PreparedAdoption> {
  const prepared = await prepareInstall(operations, environment, skill, { ...choice, scope: "user-global" });
  return { prepared, verdict: adoptionVerdict(prepared, entry) };
}
