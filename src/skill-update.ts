import path from "node:path";

import {
  inspectProjectSkillUpdate,
  updateProjectSkillTransaction,
  validateProjectSkillInstallationPreview,
  type ProjectInstallationFileSystem,
  type ProjectInstallationOptions,
  type ProjectSkillInstallationResult,
  type ProjectSkillTreeAccess,
} from "./project-installation.js";
import {
  parseProjectManifest,
  ProjectManifestStore,
  type ProjectSkillSelection,
  type SourceInstallationMethod,
} from "./project-manifest.js";
import type { SourceSkillTreeSnapshot } from "./skill-discovery.js";
import {
  executeSourceInstallationMethod,
  parseSourceInstallationMethod,
  resolveSourceInstallationMethodCwd,
  type Source,
  type SourceOperations,
} from "./sources.js";
import {
  previewUserMethod,
  type UserMethodPreview,
} from "./user-method.js";
import {
  freezeSnapshot,
  immutableUpdateSnapshot,
  type UpdateBatchAssessment,
  type UpdateBatchAssessmentItem,
} from "./update-batch.js";

export interface SkillUpdateConfirmation {
  /** Confirms replacing a locally modified tracked installation. */
  readonly overwriteModifiedInstallation?: boolean;
  /** Confirms running the previewed external command. */
  readonly externalMethod?: boolean;
}

export interface SkillUpdateApplicationOptions {
  readonly projectRoot: string;
  readonly scope: "project" | "user-global";
  readonly sourceAccess: ProjectSkillTreeAccess;
  readonly sourceOperations?: Pick<SourceOperations, "readInstallationMethod" | "executeInstallationMethod" | "updateUserGlobalInstallation" | "listUserGlobalInstallations">;
  readonly projectManifestStore?: ProjectManifestStore;
  readonly installationFileSystem?: ProjectInstallationFileSystem;
  readonly confirmation?: SkillUpdateConfirmation;
  /** Called after a method preview is produced and before the command runs. */
  readonly confirm?: (plan: SkillUpdatePlan) => SkillUpdateConfirmation | Promise<SkillUpdateConfirmation>;
  /** Injectable no-shell command runner for embedders and tests. */
  readonly executeMethod?: SourceOperations["executeInstallationMethod"];
}

export interface SkillUpdatePlan {
  readonly item: UpdateBatchAssessmentItem;
  /** Immutable selection displayed and confirmed by the caller. */
  readonly selection: ProjectSkillSelection;
  readonly source: Source;
  readonly snapshot: SourceSkillTreeSnapshot;
  readonly target: string;
  readonly overwriteRequired: boolean;
  readonly method?: SourceInstallationMethod;
  readonly methodPreview?: UserMethodPreview;
}

export interface SkillUpdateResult {
  readonly item: UpdateBatchAssessmentItem;
  readonly plan: SkillUpdatePlan;
  readonly installation: ProjectSkillInstallationResult;
}

export type UpdateBatchApplyOptions = SkillUpdateApplicationOptions;

export interface UpdateBatchResultItem {
  readonly id: string;
  readonly selection: ProjectSkillSelection;
  readonly status: "updated" | "failed";
  readonly result?: SkillUpdateResult;
  readonly error?: string;
}

export interface UpdateBatchResult {
  readonly results: readonly UpdateBatchResultItem[];
  readonly updated: readonly UpdateBatchResultItem[];
  readonly failed: readonly UpdateBatchResultItem[];
}

const immutableSnapshots = new WeakMap<SkillUpdatePlan, SourceSkillTreeSnapshot>();

/** Builds a safe update preview without changing files, state, or running methods. */
export async function previewSkillUpdate(
  item: UpdateBatchAssessmentItem,
  options: SkillUpdateApplicationOptions,
): Promise<SkillUpdatePlan> {
  if (item.status !== "updateable") {
    throw new Error(`Skill ${JSON.stringify(item.id)} is not updateable`);
  }
  if (!item.source || !item.currentSnapshot) {
    throw new Error(`Skill ${JSON.stringify(item.id)} has no immutable Source snapshot`);
  }
  if (!item.selection.installation) {
    throw new Error(`Skill ${JSON.stringify(item.id)} has no tracked installation`);
  }

  const selection = immutableSelection(item.selection);
  const snapshot = immutableUpdateSnapshot(item) ?? freezeSnapshot(item.currentSnapshot);
  await validateProjectSkillInstallationPreview({
    selection,
    source: item.source,
    previewTree: snapshot.files,
    portableV1: true,
  }, options.sourceAccess);
  const installationOptions = projectInstallationOptions(options);
  const inspection = await inspectProjectSkillUpdate(selection, installationOptions);
  const target = path.resolve(options.projectRoot, ...selection.installation!.path.split("/"));
  const method = await resolveUpdateMethod(selection, item.source, snapshot, options);
  const methodPreview = method === undefined
    ? undefined
    : previewUserMethod({
      method,
      projectRoot: options.projectRoot,
      target,
      declaredChanges: [
        `replace ${snapshot.files.length} managed files at ${target}`,
        `persist resolved version and content baseline for ${options.scope} scope`,
      ],
    });
  const plan = Object.freeze({
    item,
    selection,
    source: item.source,
    snapshot,
    target,
    overwriteRequired: inspection.requiresOverwriteConfirmation,
    ...(method === undefined ? {} : { method }),
    ...(methodPreview === undefined ? {} : { methodPreview }),
  });
  // Typed arrays cannot be frozen safely in JavaScript. Keep a private copy so
  // callback code cannot mutate the bytes that will actually be installed.
  immutableSnapshots.set(plan, freezeSnapshot(snapshot));
  return plan;
}

/** Applies one update and persists its new evidence through the selected scope seam. */
export async function applySkillUpdate(
  item: UpdateBatchAssessmentItem,
  options: SkillUpdateApplicationOptions,
): Promise<SkillUpdateResult> {
  const plan = await previewSkillUpdate(item, options);
  const confirmation = options.confirm ? await options.confirm(plan) : options.confirmation ?? {};
  if (plan.overwriteRequired && confirmation.overwriteModifiedInstallation !== true) {
    throw new Error(`Skill ${JSON.stringify(item.id)} requires explicit overwrite confirmation; no path was changed`);
  }
  if (plan.method !== undefined && confirmation.externalMethod !== true) {
    throw new Error(`Skill ${JSON.stringify(item.id)} has an external method; explicit method confirmation is required and no command was run`);
  }

  if (plan.method !== undefined) {
    // Validate the real path before staging or replacing the managed tree. The
    // injected executor is subject to the same boundary even when it is not
    // the default process runner.
    await resolveSourceInstallationMethodCwd(plan.method, options.projectRoot);
  }
  const persistedState = await preparePersistedSelection(item.selection, options);
  const transaction = await updateProjectSkillTransaction({
    selection: plan.selection,
    source: plan.source,
    previewTree: (immutableSnapshots.get(plan) ?? freezeSnapshot(plan.snapshot)).files,
    resolvedVersion: plan.snapshot.resolvedVersion ?? plan.selection.installation?.resolvedVersion,
    confirmOverwrite: confirmation.overwriteModifiedInstallation === true,
  }, projectInstallationOptions(options));

  try {
    if (plan.method !== undefined) {
      const executor = options.executeMethod ?? options.sourceOperations?.executeInstallationMethod ?? executeSourceInstallationMethod;
      await executor(plan.method, {
        source: plan.source,
        skillPath: plan.selection.path,
        projectRoot: options.projectRoot,
      });
    }
    const updatedSelection = selectionWithInstallation(plan.selection, transaction.result, options.projectRoot);
    await persistedState.apply(updatedSelection);
    await transaction.commit();
    return Object.freeze({ item, plan, installation: transaction.result });
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      rollbackErrors.push(`filesystem rollback failed: ${errorMessage(rollbackError)}`);
    }
    try {
      await persistedState.rollback();
    } catch (rollbackError) {
      rollbackErrors.push(`persisted-state rollback failed: ${errorMessage(rollbackError)}`);
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${errorMessage(error)}; ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
}

/** Applies selected entries independently and returns a complete per-skill summary. */
export async function applyUpdateBatch(
  selected: readonly UpdateBatchAssessmentItem[] | UpdateBatchAssessment,
  options: UpdateBatchApplyOptions,
): Promise<UpdateBatchResult> {
  const items = "updateable" in selected ? selected.updateable : selected;
  const results: UpdateBatchResultItem[] = [];
  for (const item of items) {
    try {
      const result = await applySkillUpdate(item, options);
      results.push(Object.freeze({ id: item.id, selection: item.selection, status: "updated", result }));
    } catch (error) {
      results.push(Object.freeze({
        id: item.id,
        selection: item.selection,
        status: "failed",
        error: errorMessage(error),
      }));
    }
  }
  const frozenResults = Object.freeze(results);
  return Object.freeze({
    results: frozenResults,
    updated: Object.freeze(results.filter((result) => result.status === "updated")),
    failed: Object.freeze(results.filter((result) => result.status === "failed")),
  });
}

/** Alias for embedders that prefer an imperative per-Skill operation name. */
export const updateSkill = applySkillUpdate;

function projectInstallationOptions(options: SkillUpdateApplicationOptions): ProjectInstallationOptions {
  return {
    projectRoot: options.projectRoot,
    sourceAccess: options.sourceAccess,
    ...(options.installationFileSystem === undefined ? {} : { fileSystem: options.installationFileSystem }),
  };
}

async function resolveUpdateMethod(
  selection: ProjectSkillSelection,
  source: Source | undefined,
  snapshot: SourceSkillTreeSnapshot,
  options: SkillUpdateApplicationOptions,
): Promise<SourceInstallationMethod | undefined> {
  const configured = selection.methods?.update;
  if (configured !== undefined) return parseSourceInstallationMethod(configured);
  const reader = options.sourceOperations?.readInstallationMethod;
  if (!reader || !source) return undefined;
  const metadata = await reader(source, selection.path, snapshot.files);
  return metadata === undefined ? undefined : parseSourceInstallationMethod(metadata);
}

interface PersistedSelectionTransaction {
  apply(selection: ProjectSkillSelection): Promise<void>;
  rollback(): Promise<void>;
}

async function preparePersistedSelection(
  originalSelection: ProjectSkillSelection,
  options: SkillUpdateApplicationOptions,
): Promise<PersistedSelectionTransaction> {
  const identity = JSON.stringify([originalSelection.source, originalSelection.path]);
  if (options.scope === "project") {
    const store = options.projectManifestStore ?? new ProjectManifestStore(path.join(options.projectRoot, "agent-depot.json"));
    const manifest = await store.load();
    if (!manifest.skills.some((selection) => JSON.stringify([selection.source, selection.path]) === identity)) {
      throw new Error(`Project manifest does not contain Skill ${JSON.stringify(originalSelection.path)}`);
    }
    let applied = false;
    return {
      apply: async (updatedSelection) => {
        applied = true;
        const next = parseProjectManifest({
          version: 1,
          skills: manifest.skills.map((selection) =>
            JSON.stringify([selection.source, selection.path]) === identity ? updatedSelection : selection,
          ),
        });
        await store.save(next);
      },
      rollback: async () => {
        if (applied) await store.save(manifest);
      },
    };
  }

  const updateGlobal = options.sourceOperations?.updateUserGlobalInstallation;
  if (!updateGlobal) {
    throw new Error("Configured Source operations cannot persist user-global Skill updates");
  }
  const installations = await options.sourceOperations?.listUserGlobalInstallations?.();
  const previous = installations?.find((selection) => JSON.stringify([selection.source, selection.path]) === identity) ?? originalSelection;
  let applied = false;
  return {
    apply: async (updatedSelection) => {
      applied = true;
      await updateGlobal(updatedSelection);
    },
    rollback: async () => {
      if (applied) await updateGlobal(previous);
    },
  };
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
  const relative = path.relative(path.resolve(projectRoot), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Installed Skill location escapes the scope root: ${candidate}`);
  }
  return relative.split(path.sep).join("/");
}

function immutableSelection(selection: ProjectSkillSelection): ProjectSkillSelection {
  const parsed = parseProjectManifest({ version: 1, skills: [selection] }).skills[0];
  if (!parsed) throw new Error("Skill update selection is missing");
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
