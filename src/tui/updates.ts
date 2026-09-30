import { formatVersionPolicy } from "../skill-install.js";
import type { SourceOperations } from "../sources.js";
import type { UpdateBatchAssessmentItem } from "../update-batch.js";
import {
  applyConfirmedUpdates,
  describeUpdatePreview,
  loadUpdates,
  previewUpdateCandidates,
  type LoadedUpdates,
  type UpdatePreviewFailure,
  type UpdateScope,
} from "../update-flow.js";
import type { TuiEnvironment } from "./environment.js";
import { formatVersionEvidence } from "./installations.js";

export type { UpdateScope };

/** One installed Skill as the Updates view shows it. */
export interface UpdateRow {
  readonly item: UpdateBatchAssessmentItem;
  readonly path: string;
  readonly policy: string;
  readonly installed: string;
  readonly available: string;
  readonly status: "update available" | "up to date" | "cannot assess";
  readonly reason: string;
}

export interface UpdatesData {
  readonly scope: UpdateScope;
  readonly loaded: LoadedUpdates;
  readonly rows: readonly UpdateRow[];
}

const STATUS_LABEL = {
  updateable: "update available",
  current: "up to date",
  unknown: "cannot assess",
} as const;

/** Runs the same assessment `update check` performs for the scope. Changes nothing. */
export async function loadUpdateRows(
  operations: SourceOperations,
  environment: TuiEnvironment,
  scope: UpdateScope,
): Promise<UpdatesData> {
  const loaded = await loadUpdates({
    scope,
    operations,
    ...(environment.homeDirectory === undefined ? {} : { homeDirectory: environment.homeDirectory }),
    ...(environment.projectRoot === undefined ? {} : { projectRoot: environment.projectRoot }),
    ...(environment.sourceAccess === undefined ? {} : { sourceAccess: environment.sourceAccess }),
    ...(environment.projectManifestStore === undefined ? {} : { projectManifestStore: environment.projectManifestStore }),
    ...(environment.installationOptions?.fileSystem === undefined ? {} : { installationFileSystem: environment.installationOptions.fileSystem }),
  });
  const rows = loaded.assessment.items.map((item): UpdateRow => ({
    item,
    path: item.selection.path,
    policy: formatVersionPolicy(item.selection.version),
    installed: formatVersionEvidence(item.selection.installation?.resolvedVersion),
    available: item.currentVersion === undefined ? "?" : formatVersionEvidence(item.currentVersion),
    status: STATUS_LABEL[item.status],
    reason: item.reason,
  }));
  return { scope, loaded, rows };
}

export interface PreparedUpdates {
  readonly scope: UpdateScope;
  readonly loaded: LoadedUpdates;
  /** The exact `update apply` preview of every candidate whose preview succeeded. */
  readonly lines: readonly string[];
  /** Items whose preview succeeded; only these are applied. */
  readonly applicable: readonly UpdateBatchAssessmentItem[];
  readonly failures: readonly UpdatePreviewFailure[];
  /** Relative non-canonical locations that need their own explicit confirmation. */
  readonly nonCanonicalPaths: readonly string[];
}

/** Plan step: previews the selection from the assessed snapshots. Changes nothing. */
export async function prepareUpdates(
  data: UpdatesData,
  selected: readonly UpdateBatchAssessmentItem[],
): Promise<PreparedUpdates> {
  const { context } = data.loaded;
  const outcome = await previewUpdateCandidates(selected, context);
  return {
    scope: data.scope,
    loaded: data.loaded,
    lines: outcome.plans.flatMap((plan) => describeUpdatePreview(plan, data.scope, context.projectRoot, "prompt")),
    applicable: outcome.plans.map((plan) => plan.item),
    failures: outcome.failures,
    nonCanonicalPaths: outcome.nonCanonicalPaths,
  };
}

export interface UpdateOutcome {
  readonly lines: readonly string[];
  readonly failed: number;
}

/**
 * Applies exactly the previewed items. Confirming the preview confirms
 * overwriting and external commands; non-canonical paths are confirmed only
 * when the caller passes them after the separate confirmation.
 */
export async function runUpdates(prepared: PreparedUpdates, confirmedPaths: readonly string[]): Promise<UpdateOutcome> {
  const { context } = prepared.loaded;
  const result = await applyConfirmedUpdates(prepared.applicable, context, confirmedPaths);
  const previewFailed = prepared.failures.map(
    ({ item, message }) => `Failed ${item.selection.path}: preview failed: ${message}`,
  );
  const failed = result.failed.length + previewFailed.length;
  return {
    failed,
    lines: [
      ...result.updated.map((item) => `Updated ${item.selection.path}`),
      ...result.failed.map((item) => `Failed ${item.selection.path}: ${item.error ?? "unknown error"}`),
      ...previewFailed,
      `Update summary: ${result.updated.length} updated, ${failed} failed`,
    ],
  };
}

