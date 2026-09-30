import { homedir } from "node:os";
import path from "node:path";

import {
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  type ProjectHost,
  type ProjectSkillSelection,
  type ProjectSource,
  type VersionPolicy,
} from "../project-manifest.js";
import {
  defaultProjectSkillTreeAccess,
  confirmSingleInstallPlan,
  executeSingleInstall,
  needsAdditionalHostExposure,
  outputSingleInstallPreview,
  planSingleInstall,
  type SingleInstallPlan,
} from "../skill-install.js";
import type { SkillCandidate } from "../skill-discovery.js";
import {
  executeSkillRemoval,
  planSkillRemoval,
  userGlobalRemovalOptions,
  type SkillRemovalPlan,
} from "../skill-removal.js";
import type { Source, SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";

export type InstallScope = "project" | "user-global";

/** Installations known to the Catalog, plus the Sources used to match them to discovered Skills. */
export interface InstalledSkills {
  readonly global: readonly ProjectSkillSelection[];
  readonly project: readonly ProjectSkillSelection[];
  readonly sources: readonly Source[];
}

export const NO_INSTALLED: InstalledSkills = { global: [], project: [], sources: [] };

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
  return { global, project, sources };
}

function matchesSource(source: ProjectSource, sourceId: string, sources: readonly Source[]): boolean {
  if (source.kind === "builtin") return source.id === sourceId;
  if (!("url" in source)) return false;
  return sources.some((candidate) => candidate.kind === "git" && candidate.id === sourceId && candidate.url === source.url);
}

function recordsFor(records: readonly ProjectSkillSelection[], skill: SkillCandidate, sources: readonly Source[]) {
  return records.filter((record) => record.path === skill.path && matchesSource(record.source, skill.sourceId, sources));
}

/** Marker such as `[global: claude] [project: codex]`; empty when the Skill is not installed. */
export function installMarker(skill: SkillCandidate, installed: InstalledSkills): string {
  const parts: string[] = [];
  for (const [label, records] of [["global", installed.global], ["project", installed.project]] as const) {
    const hosts = [...new Set(recordsFor(records, skill, installed.sources).flatMap((record) => record.hosts))];
    if (hosts.length > 0) parts.push(`[${label}: ${hosts.join(", ")}]`);
  }
  return parts.join(" ");
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

/** Plan step: resolves and inspects the install and renders the same preview the CLI prints. */
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
    confirmed: false,
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
  // Like `install --yes`: refresh the Source, then resolve and inspect again before writing.
  const confirmed = await confirmSingleInstallPlan(prepared.plan);
  const plan = confirmAdditionalHostExposure
    ? { ...confirmed, request: { ...confirmed.request, confirmAdditionalHostExposure: true } }
    : confirmed;
  const persist = manifestStore
    ? async (record: ProjectSkillSelection) => {
        await manifestStore.save(parseProjectManifest({ version: 1, skills: [...plan.context.existing, record] }));
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
