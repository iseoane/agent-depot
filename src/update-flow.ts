import { homedir } from "node:os";
import path from "node:path";

import { checkAppUpdates, type AppOperations } from "./app-flow.js";

import {
  type ProjectInstallationFileSystem,
  type ProjectSkillTreeAccess,
} from "./project-installation.js";
import {
  defaultProjectManifestPath,
  ProjectManifestStore,
  type ProjectSkillSelection,
  type ProjectSource,
} from "./project-manifest.js";
import { defaultProjectSkillTreeAccess } from "./skill-install.js";
import {
  applyUpdateBatch,
  previewSkillUpdate,
  relativeProjectPath,
  type SkillUpdateApplicationOptions,
  type SkillUpdatePlan,
  type UpdateBatchResult,
} from "./skill-update.js";
import { resolveProjectSource, type SourceOperations } from "./sources.js";
import {
  assessUpdateBatch,
  type UpdateBatchAssessment,
  type UpdateBatchAssessmentItem,
} from "./update-batch.js";

export type UpdateScope = "project" | "user-global";

/** Where an update check reads installations from; defaults mirror the CLI (real home and cwd). */
export interface UpdateScopeInput {
  readonly apps?: AppOperations;
  readonly scope: UpdateScope;
  readonly operations: SourceOperations;
  readonly homeDirectory?: string;
  readonly projectRoot?: string;
  readonly sourceAccess?: ProjectSkillTreeAccess;
  readonly projectManifestStore?: ProjectManifestStore;
  readonly installationFileSystem?: ProjectInstallationFileSystem;
}

export interface LoadedUpdates {
  readonly assessment: UpdateBatchAssessment;
  readonly appUpdates: readonly Awaited<ReturnType<AppOperations["checkUpdate"]>>[];
  /** Installations of the scope, as assessed. */
  readonly installed: readonly ProjectSkillSelection[];
  /** Shared options for preview and apply; the assessment snapshots are never reread. */
  readonly context: SkillUpdateApplicationOptions;
}

/** Where the scope's installations live: its root and, for the project scope, its manifest store. */
function scopeLocation(input: UpdateScopeInput): { readonly projectRoot: string; readonly manifestStore?: ProjectManifestStore } {
  if (input.scope === "user-global") return { projectRoot: path.resolve(input.homeDirectory ?? homedir()) };
  const projectRoot = path.resolve(input.projectRoot ?? process.cwd());
  return {
    projectRoot,
    manifestStore: input.projectManifestStore ?? new ProjectManifestStore(defaultProjectManifestPath(projectRoot)),
  };
}

/** The scope's installations, read without assessing them. */
export async function readScopeInstallations(input: UpdateScopeInput): Promise<readonly ProjectSkillSelection[]> {
  const { manifestStore } = scopeLocation(input);
  return manifestStore ? (await manifestStore.load()).skills : requireUserGlobalInstallations(input.operations);
}

/** Loads the scope's installations and assesses them like `update check`. Changes nothing. */
export async function loadUpdates(input: UpdateScopeInput): Promise<LoadedUpdates> {
  const { scope, operations } = input;
  const sourceAccess = input.sourceAccess ?? defaultProjectSkillTreeAccess();
  const { projectRoot, manifestStore } = scopeLocation(input);
  const installed = await readScopeInstallations(input);
  const resolveSource = operations.resolveProjectSource
    ? (source: ProjectSource) => operations.resolveProjectSource!(source)
    : resolveProjectSource;
  const assessment = await assessUpdateBatch(installed, { sourceAccess, resolveSource });
  const context: SkillUpdateApplicationOptions = {
    projectRoot,
    scope,
    sourceAccess,
    sourceOperations: operations,
    trackedInstallationPaths: installed.flatMap((selection) => selection.installation === undefined ? [] : [selection.installation.path]),
    ...(manifestStore === undefined ? {} : { projectManifestStore: manifestStore }),
    ...(input.installationFileSystem === undefined ? {} : { installationFileSystem: input.installationFileSystem }),
  };
  const appUpdates = input.scope === "user-global" && input.apps
    ? await checkAppUpdates(input.apps)
    : [];
  return { assessment, installed, context, appUpdates };
}

async function requireUserGlobalInstallations(operations: SourceOperations): Promise<readonly ProjectSkillSelection[]> {
  if (!operations.listUserGlobalInstallations) {
    throw new Error("Configured Source operations cannot inspect user-global Skill updates");
  }
  return operations.listUserGlobalInstallations();
}

export interface UpdatePreviewFailure {
  readonly item: UpdateBatchAssessmentItem;
  readonly message: string;
}

export interface UpdatePreviewOutcome {
  readonly plans: readonly SkillUpdatePlan[];
  readonly failures: readonly UpdatePreviewFailure[];
  /** Relative non-canonical project paths that need explicit confirmation, in preview order. */
  readonly nonCanonicalPaths: readonly string[];
}

/** Previews every selected candidate independently; a failing preview never hides the others. */
export async function previewUpdateCandidates(
  selected: readonly UpdateBatchAssessmentItem[],
  context: SkillUpdateApplicationOptions,
): Promise<UpdatePreviewOutcome> {
  const plans: SkillUpdatePlan[] = [];
  const failures: UpdatePreviewFailure[] = [];
  const nonCanonicalPaths: string[] = [];
  for (const item of selected) {
    try {
      const plan = await previewSkillUpdate(item, context);
      if (plan.nonCanonicalPath !== undefined) nonCanonicalPaths.push(relativeProjectPath(context.projectRoot, plan.nonCanonicalPath));
      plans.push(plan);
    } catch (error) {
      failures.push({ item, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { plans, failures, nonCanonicalPaths };
}

/** How the preview names the confirmations: CLI flags or the interactive prompts. */
export type UpdateConfirmationWording = "flags" | "prompt";

/** The preview `update apply` prints for one candidate. */
export function describeUpdatePreview(
  plan: SkillUpdatePlan,
  scope: UpdateScope,
  projectRoot: string,
  wording: UpdateConfirmationWording = "flags",
): readonly string[] {
  const lines = [
    `Preview: update Skill ${JSON.stringify(plan.selection.path)} from ${plan.source.id} (scope: ${scope})`,
    `  target: ${plan.target}`,
  ];
  if (plan.nonCanonicalPath !== undefined) {
    const relative = relativeProjectPath(projectRoot, plan.nonCanonicalPath);
    lines.push(wording === "flags"
      ? `  WARNING: non-canonical location ${JSON.stringify(relative)} (outside .agents/skills and .claude/skills); --yes together with --confirm-path ${relative} explicitly confirms replacing this exact path`
      : `  WARNING: non-canonical location ${JSON.stringify(relative)} (outside .agents/skills and .claude/skills); a separate confirmation of this exact path is required to replace it`);
  }
  lines.push(`  proposed changes: replace ${plan.snapshot.files.length} managed files and persist the new version/content baseline`);
  if (plan.overwriteRequired) {
    lines.push(wording === "flags"
      ? "  WARNING: the installed Skill has local modifications; --yes explicitly confirms replacing them"
      : "  WARNING: the installed Skill has local modifications; confirming replaces them");
  }
  if (plan.methodPreview) {
    lines.push(
      `  external command: argv=${JSON.stringify(plan.methodPreview.argv)}`,
      `  external cwd: ${JSON.stringify(plan.methodPreview.cwd)}`,
      `  external target: ${JSON.stringify(plan.methodPreview.target)}`,
      "  declared changes:",
      ...plan.methodPreview.declaredChanges.map((change) => `    ${change}`),
      `  WARNING: ${plan.methodPreview.warning}`,
    );
  }
  return lines;
}

/**
 * `--yes` alone never confirms a repository-controlled non-canonical location:
 * every pending path needs its own exact confirmation, and a value that matches
 * no pending path is an error rather than silently ignored. Returns the problem, if any.
 */
export function findPathConfirmationProblem(pending: readonly string[], confirmedPaths: readonly string[]): string | undefined {
  const unmatched = confirmedPaths.filter((value) => !pending.includes(value));
  if (unmatched.length > 0) {
    const shown = pending.length === 0 ? "none" : pending.map((value) => JSON.stringify(value)).join(", ");
    return `--confirm-path ${unmatched.map((value) => JSON.stringify(value)).join(", ")} does not match any pending non-canonical location (pending: ${shown}); no path was changed`;
  }
  const missing = pending.filter((value) => !confirmedPaths.includes(value));
  if (missing.length > 0) {
    const flags = missing.map((value) => `--confirm-path ${value}`).join(" ");
    return `Non-canonical location ${missing.map((value) => JSON.stringify(value)).join(", ")} needs explicit path confirmation; --yes alone is not enough. Rerun with ${flags}; no path was changed`;
  }
  return undefined;
}

/**
 * Applies the selected updates after the caller collected the confirmation.
 * Overwriting modified installations and running external methods are confirmed
 * by that same confirmation; a non-canonical path only when its exact relative
 * path is listed.
 */
export function applyConfirmedUpdates(
  selected: readonly UpdateBatchAssessmentItem[],
  context: SkillUpdateApplicationOptions,
  confirmedPaths: readonly string[],
  /** Ids of the items whose preview showed the overwrite of local modifications; when given, any other item that turns out modified fails instead of being overwritten. */
  previewedOverwrites?: ReadonlySet<string>,
): Promise<UpdateBatchResult> {
  return applyUpdateBatch(selected, {
    ...context,
    // The callback is invoked independently for every candidate. In particular,
    // a modified installation is never overwritten unless the caller confirmed.
    confirm: async (plan) => {
      if (previewedOverwrites !== undefined && plan.overwriteRequired && !previewedOverwrites.has(plan.item.id)) {
        throw new Error(`Skill ${JSON.stringify(plan.item.id)} was modified after the preview, so the overwrite was never shown or confirmed; nothing was changed`);
      }
      return {
      overwriteModifiedInstallation: true,
      externalMethod: true,
      ...(plan.nonCanonicalPath !== undefined && confirmedPaths.includes(relativeProjectPath(context.projectRoot, plan.nonCanonicalPath))
        ? { nonCanonicalPath: plan.nonCanonicalPath }
        : {}),
      };
    },
  });
}
