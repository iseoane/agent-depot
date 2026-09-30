import { formatVersionPolicy } from "../skill-install.js";
import type { SourceOperations } from "../sources.js";
import type { UpdateBatchAssessmentItem } from "../update-batch.js";
import type { ProjectSkillSelection, ProjectSource } from "../project-manifest.js";
import {
  applyConfirmedUpdates,
  describeUpdatePreview,
  loadUpdates,
  previewUpdateCandidates,
  readScopeInstallations,
  type LoadedUpdates,
  type UpdatePreviewFailure,
  type UpdateScope,
} from "../update-flow.js";
import type { TuiEnvironment } from "./environment.js";
import { formatVersionEvidence } from "./installations.js";

export type { UpdateScope };

/** Scope filter of the view; `all` merges the project and user-global installations. */
export type UpdateScopeFilter = "all" | UpdateScope;

/** Every scope the view can assess, in display order. */
export const UPDATE_SCOPES: readonly UpdateScope[] = ["project", "user-global"];

/** One installed Skill as the Updates view shows it. */
export interface UpdateRow {
  /** Unique across scopes: the same Skill can be installed in both. */
  readonly key: string;
  readonly scope: UpdateScope;
  readonly item: UpdateBatchAssessmentItem;
  readonly path: string;
  readonly policy: string;
  readonly installed: string;
  readonly available: string;
  readonly status: "update available" | "up to date" | "cannot assess";
  readonly reason: string;
}

/** The assessment of one scope, or why it could not be read. */
export interface ScopeResult {
  readonly scope: UpdateScope;
  readonly loaded?: LoadedUpdates;
  readonly error?: string;
}

export interface SourceRefreshFailure {
  /** The Source's URL (with its ref, when set). */
  readonly source: string;
  readonly reason: string;
}

/** What refreshing the Git sources before the check did. */
export interface RefreshReport {
  /** False when the check reused earlier data (for example after an apply). */
  readonly attempted: boolean;
  readonly refreshed: readonly string[];
  readonly failed: readonly SourceRefreshFailure[];
  /** Scopes whose installations could not be read to find the sources to refresh; the check used the cached data. */
  readonly unreadable: readonly { readonly scope: UpdateScope; readonly reason: string }[];
}

/** A non-canonical location together with the scope it belongs to: the same relative path can exist in both. */
export interface ScopedPath {
  readonly scope: UpdateScope;
  readonly path: string;
}

export interface UpdatesData {
  readonly results: readonly ScopeResult[];
  readonly rows: readonly UpdateRow[];
  readonly refresh: RefreshReport;
  /** Milliseconds since the epoch when the assessment finished. */
  readonly checkedAt: number;
}

export type UpdatesPhase = "refreshing" | "checking";

export interface LoadUpdatesOptions {
  /** Refresh the Git sources of the installations before assessing. */
  readonly refresh: boolean;
  readonly onPhase?: (phase: UpdatesPhase) => void;
  readonly now?: () => number;
}

const STATUS_LABEL = {
  updateable: "update available",
  current: "up to date",
  unknown: "cannot assess",
} as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeInput(operations: SourceOperations, environment: TuiEnvironment, scope: UpdateScope) {
  return {
    scope,
    operations,
    ...(environment.homeDirectory === undefined ? {} : { homeDirectory: environment.homeDirectory }),
    ...(environment.projectRoot === undefined ? {} : { projectRoot: environment.projectRoot }),
    ...(environment.sourceAccess === undefined ? {} : { sourceAccess: environment.sourceAccess }),
    ...(environment.projectManifestStore === undefined ? {} : { projectManifestStore: environment.projectManifestStore }),
    ...(environment.installationOptions?.fileSystem === undefined ? {} : { installationFileSystem: environment.installationOptions.fileSystem }),
  };
}

type GitProjectSource = Extract<ProjectSource, { readonly url: string }>;

/** Refreshes through the project-source operation the install flow uses; a registered Source is refreshed by id otherwise. */
async function refreshOne(operations: SourceOperations, source: GitProjectSource): Promise<void> {
  if (operations.refreshProjectSource) {
    await operations.refreshProjectSource(source);
    return;
  }
  const registered = (await operations.listSources()).find((candidate) => candidate.kind === "git" && candidate.url === source.url);
  if (!registered) throw new Error("the Source is not registered, so it cannot be refreshed here");
  await operations.refreshSource(registered.id);
}

/** Refreshes every distinct Git source the installations use, one at a time; the built-in source is skipped. */
async function refreshSources(operations: SourceOperations, selections: readonly ProjectSkillSelection[]): Promise<RefreshReport> {
  const distinct = new Map<string, GitProjectSource>();
  for (const { source } of selections) {
    if (source.kind === "external" && "url" in source) distinct.set(`${source.url}\u0000${source.ref ?? ""}`, source);
  }
  const refreshed: string[] = [];
  const failed: SourceRefreshFailure[] = [];
  for (const source of distinct.values()) {
    const label = source.ref === undefined ? source.url : `${source.url}@${source.ref}`;
    try {
      await refreshOne(operations, source);
      refreshed.push(label);
    } catch (error) {
      failed.push({ source: label, reason: errorText(error) });
    }
  }
  return { attempted: true, refreshed, failed, unreadable: [] };
}

/**
 * Refreshes the Git sources involved (unless told otherwise), then runs the
 * same assessment `update check` performs for every scope. A source that
 * fails to refresh is reported and the check still uses its current data.
 * Changes nothing but the Source caches.
 */
export async function loadUpdateRows(
  operations: SourceOperations,
  environment: TuiEnvironment,
  options: LoadUpdatesOptions,
): Promise<UpdatesData> {
  let refresh: RefreshReport = { attempted: false, refreshed: [], failed: [], unreadable: [] };
  if (options.refresh) {
    options.onPhase?.("refreshing");
    const unreadable: { scope: UpdateScope; reason: string }[] = [];
    const installations = await Promise.all(
      UPDATE_SCOPES.map((scope) => readScopeInstallations(scopeInput(operations, environment, scope)).catch((error: unknown) => {
        unreadable.push({ scope, reason: errorText(error) });
        return [];
      })),
    );
    refresh = { ...(await refreshSources(operations, installations.flat())), unreadable };
  }
  options.onPhase?.("checking");
  const results = await Promise.all(UPDATE_SCOPES.map(async (scope): Promise<ScopeResult> => {
    try {
      return { scope, loaded: await loadUpdates(scopeInput(operations, environment, scope)) };
    } catch (error) {
      return { scope, error: errorText(error) };
    }
  }));
  const rows = results.flatMap(({ scope, loaded }) =>
    (loaded?.assessment.items ?? []).map((item): UpdateRow => ({
      key: `${scope}:${item.id}`,
      scope,
      item,
      path: item.selection.path,
      policy: formatVersionPolicy(item.selection.version),
      installed: formatVersionEvidence(item.selection.installation?.resolvedVersion),
      available: item.currentVersion === undefined ? "?" : formatVersionEvidence(item.currentVersion),
      status: STATUS_LABEL[item.status],
      reason: item.reason,
    })));
  return { results, rows, refresh, checkedAt: (options.now ?? Date.now)() };
}

/** `just now`, `42s ago`, `5 min ago`, `2 h ago`. */
export function formatAgo(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(elapsedMs, 0) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** The preview of the selected items of one scope. */
export interface PreparedUpdateGroup {
  readonly scope: UpdateScope;
  readonly loaded: LoadedUpdates;
  /** Items whose preview succeeded; only these are applied. */
  readonly applicable: readonly UpdateBatchAssessmentItem[];
  /** Relative non-canonical locations of this scope that need their own explicit confirmation. */
  readonly nonCanonicalPaths: readonly string[];
  /** Ids of the items whose preview showed the overwrite of local modifications. */
  readonly overwriteShown: ReadonlySet<string>;
}

export interface PreparedUpdates {
  readonly groups: readonly PreparedUpdateGroup[];
  /** The exact `update apply` preview of every candidate whose preview succeeded. */
  readonly lines: readonly string[];
  /** Items whose preview succeeded, across scopes; only these are applied. */
  readonly applicable: readonly UpdateBatchAssessmentItem[];
  readonly failures: readonly UpdatePreviewFailure[];
  /** Non-canonical locations, per scope, that need their own explicit confirmation. */
  readonly nonCanonicalPaths: readonly ScopedPath[];
}

/** Plan step: previews the selection from the assessed snapshots, scope by scope. Changes nothing. */
export async function prepareUpdates(
  data: UpdatesData,
  selected: readonly UpdateRow[],
): Promise<PreparedUpdates> {
  const groups: PreparedUpdateGroup[] = [];
  const lines: string[] = [];
  const failures: UpdatePreviewFailure[] = [];
  for (const { scope, loaded } of data.results) {
    const items = selected.filter((row) => row.scope === scope).map((row) => row.item);
    if (!loaded || items.length === 0) continue;
    const { context } = loaded;
    const outcome = await previewUpdateCandidates(items, context);
    lines.push(...outcome.plans.flatMap((plan) => describeUpdatePreview(plan, scope, context.projectRoot, "prompt")));
    failures.push(...outcome.failures);
    groups.push({
      scope,
      loaded,
      applicable: outcome.plans.map((plan) => plan.item),
      nonCanonicalPaths: outcome.nonCanonicalPaths,
      overwriteShown: new Set(outcome.plans.filter((plan) => plan.overwriteRequired).map((plan) => plan.item.id)),
    });
  }
  return {
    groups,
    lines,
    applicable: groups.flatMap((group) => group.applicable),
    failures,
    nonCanonicalPaths: groups.flatMap((group) => group.nonCanonicalPaths.map((location) => ({ scope: group.scope, path: location }))),
  };
}

export interface UpdateOutcome {
  readonly lines: readonly string[];
  readonly failed: number;
}

/**
 * Applies exactly the previewed items, scope by scope. Confirming the preview
 * confirms overwriting and external commands; a non-canonical path is applied
 * only when the caller passes it (with its scope) after the separate confirmation.
 * A Skill that became locally modified after the preview fails instead of being overwritten.
 */
export async function runUpdates(prepared: PreparedUpdates, confirmedPaths: readonly ScopedPath[]): Promise<UpdateOutcome> {
  const updated: string[] = [];
  const failedLines: string[] = [];
  for (const group of prepared.groups) {
    const result = await applyConfirmedUpdates(
      group.applicable,
      group.loaded.context,
      confirmedPaths
        .filter((confirmed) => confirmed.scope === group.scope && group.nonCanonicalPaths.includes(confirmed.path))
        .map((confirmed) => confirmed.path),
      group.overwriteShown,
    );
    updated.push(...result.updated.map((item) => `Updated ${item.selection.path}`));
    failedLines.push(...result.failed.map((item) => `Failed ${item.selection.path}: ${item.error ?? "unknown error"}`));
  }
  const previewFailed = prepared.failures.map(
    ({ item, message }) => `Failed ${item.selection.path}: preview failed: ${message}`,
  );
  const failed = failedLines.length + previewFailed.length;
  return {
    failed,
    lines: [...updated, ...failedLines, ...previewFailed, `Update summary: ${updated.length} updated, ${failed} failed`],
  };
}
