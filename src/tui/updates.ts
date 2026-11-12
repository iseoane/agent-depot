import { checkAppUpdates, createAppOperations, type AppOperations, type AppUpdateCheck, type AppLifecyclePlan } from "../app-flow.js";
import type { FlowProgress } from "../flow-progress.js";
import type { PackageOperations } from "../package-flow.js";
import { displayPackageCoordinates, displayPackageSelection, selectionKey, type PackageLifecyclePlan, type PackageUpdateCheck } from "../package-model.js";
import type { PackageApprovalStatus } from "../package-state.js";
import { formatVersionPolicy } from "../skill-install.js";
import { sourceIdForUrl } from "../git-source.js";
import type { SourceRefreshSession } from "../source-refresh-session.js";
import type { SourceOperations, SourceRefreshOptions } from "../sources.js";
import type { UpdateBatchAssessmentItem } from "../update-batch.js";
import type { ProjectSkillSelection, ProjectSource } from "../project-manifest.js";
import {
  applyConfirmedUpdates,
  loadUpdates,
  previewUpdateCandidates,
  readScopeInstallations,
  skillUpdatePreviewItem,
  type LoadedUpdates,
  type UpdatePreviewFailure,
  type UpdateScope,
} from "../update-flow.js";
import type { TuiEnvironment } from "./environment.js";
import { packageOperationsOf } from "./environment.js";
import { formatVersionEvidence } from "./installations.js";
import { describePackageComponent, installedEvidenceLabel, packageStatusLabel, packageVersionLabel, recordedVersionLabel } from "./package-rows.js";
import { quoteText, type PreviewDocument, type PreviewItem, type PreviewRow } from "../preview-model.js";

export type { UpdateScope };

/** Scope filter of the view; `all` merges the project and user-global installations. */
export type UpdateScopeFilter = "all" | UpdateScope;

/** Every scope the view can assess, in display order. */
export const UPDATE_SCOPES: readonly UpdateScope[] = ["project", "user-global"];

/** One installed Skill as the Updates view shows it. */
interface SkillUpdateRow {
  readonly kind: "skill";
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

/** One App check in the user-global Updates list. */
export interface AppUpdateRow {
  readonly kind: "app";
  readonly key: string;
  readonly scope: "user-global";
  readonly check: AppUpdateCheck;
  readonly path: string;
  readonly policy: string;
  readonly installed: string;
  readonly available: string;
  readonly status: SkillUpdateRow["status"];
  readonly reason: string;
}
export type UpdateRow = SkillUpdateRow | AppUpdateRow | PackageUpdateRow;

/** One recorded Package as the user-global Updates list shows it. */
export interface PackageUpdateRow {
  readonly kind: "package";
  readonly key: string;
  readonly scope: "user-global";
  readonly check: PackageUpdateCheck;
  readonly path: string;
  readonly policy: string;
  readonly installed: string;
  readonly available: string;
  readonly status: SkillUpdateRow["status"];
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
  /** When the oldest reused refresh finished, if a recent refresh stood in for a new one. */
  readonly reusedAt?: number;
}

/** A non-canonical location together with the scope it belongs to: the same relative path can exist in both. */
export interface ScopedPath {
  readonly scope: UpdateScope;
  readonly path: string;
}

export interface UpdatesData {
  readonly results: readonly ScopeResult[];
  readonly rows: readonly UpdateRow[];
  /** App inventory/check failures are independent of Skill scope errors. */
  readonly appError?: string;
  /** Package check failures are independent of the Skill scopes and the App inventory. */
  readonly packageError?: string;
  readonly refresh: RefreshReport;
  /** Milliseconds since the epoch when the assessment finished. */
  readonly checkedAt: number;
  /** Core operations bound to the environment used for this check. */
  readonly apps?: AppOperations;
  readonly packages?: PackageOperations;
}

export type UpdatesPhase = "refreshing" | "checking";

export interface LoadUpdatesOptions {
  /** Refresh the Git sources of the installations before assessing. */
  readonly refresh: boolean;
  /** Refresh even when a refresh session holds a recent one (`r`). */
  readonly force?: boolean;
  readonly onPhase?: (phase: UpdatesPhase) => void;
  readonly now?: () => number;
}

const APP_STATUS_LABEL = {
  "update available": "update available",
  current: "up to date",
  unknown: "cannot assess",
} as const;

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
async function refreshOne(operations: SourceOperations, source: GitProjectSource, options: SourceRefreshOptions): Promise<void> {
  if (operations.refreshProjectSource) {
    await operations.refreshProjectSource(source, options);
    return;
  }
  const registered = (await operations.listSources()).find((candidate) => candidate.kind === "git" && candidate.url === source.url);
  if (!registered) throw new Error("the Source is not registered, so it cannot be refreshed here");
  await operations.refreshSource(registered.id, options);
}

/** Refreshes every distinct Git source the installations use, one at a time; the built-in source is skipped. */
async function refreshSources(
  operations: SourceOperations,
  selections: readonly ProjectSkillSelection[],
  options: SourceRefreshOptions,
  session: SourceRefreshSession | undefined,
): Promise<RefreshReport> {
  const distinct = new Map<string, GitProjectSource>();
  for (const { source } of selections) {
    if (source.kind === "external" && "url" in source) distinct.set(`${source.url}\u0000${source.ref ?? ""}`, source);
  }
  const refreshed: string[] = [];
  const failed: SourceRefreshFailure[] = [];
  const startedAt = session?.now();
  let reusedAt: number | undefined;
  for (const source of distinct.values()) {
    const label = source.ref === undefined ? source.url : `${source.url}@${source.ref}`;
    try {
      await refreshOne(operations, source, options);
      refreshed.push(label);
      // A refresh that finished before this check began was reused, not made now.
      const finishedAt = session?.snapshot().get(sourceIdForUrl(source.url))?.finishedAt;
      if (startedAt !== undefined && finishedAt !== undefined && finishedAt < startedAt) {
        reusedAt = Math.min(reusedAt ?? finishedAt, finishedAt);
      }
    } catch (error) {
      failed.push({ source: label, reason: errorText(error) });
    }
  }
  return { attempted: true, refreshed, failed, unreadable: [], ...(reusedAt === undefined ? {} : { reusedAt }) };
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
  const apps = createAppOperations({ homeDirectory: environment.homeDirectory, ...environment.appEnvironment });
  const packages = packageOperationsOf(environment);
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
    refresh = { ...(await refreshSources(operations, installations.flat(), { force: options.force === true }, environment.refreshSession)), unreadable };
  }
  options.onPhase?.("checking");
  const results = await Promise.all(UPDATE_SCOPES.map(async (scope): Promise<ScopeResult> => {
    try {
      return { scope, loaded: await loadUpdates(scopeInput(operations, environment, scope)) };
    } catch (error) {
      return { scope, error: errorText(error) };
    }
  }));
  const rows: UpdateRow[] = results.flatMap(({ scope, loaded }) =>
    (loaded?.assessment.items ?? []).map((item): UpdateRow => ({
      kind: "skill",
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
  let appChecks: readonly AppUpdateCheck[] = [];
  let appError: string | undefined;
  try {
    appChecks = await checkAppUpdates(apps);
  } catch (error) {
    appError = errorText(error);
  }
  for (const check of appChecks.filter(candidate => candidate.inspection.status === "installed")) {
    rows.push({
      kind: "app",
      key: `app:${check.entry.file}`,
      scope: "user-global",
      check,
      path: `App: ${check.entry.recipe?.name ?? check.entry.file}`,
      policy: "latest",
      installed: check.installedVersion ?? "?",
      available: check.latestVersion ?? "?",
      status: APP_STATUS_LABEL[check.status],
      reason: check.reason ?? check.inspection.reason ?? check.inspection.status,
    });
  }
  let packageChecks: readonly PackageUpdateCheck[] = [];
  let packageError: string | undefined;
  try {
    packageChecks = await packages.checkUpdates();
  } catch (error) {
    packageError = errorText(error);
  }
  for (const check of packageChecks) {
    rows.push({
      kind: "package",
      key: `package:${selectionKey(check.installed.selection)}`,
      scope: "user-global",
      check,
      path: `Package: ${displayPackageSelection(check.installed.selection)}`,
      policy: formatVersionPolicy(check.installed.selection.version),
      installed: check.observed === undefined
        ? `${recordedVersionLabel(check.installed)} (recorded)`
        : installedEvidenceLabel(check.observed).replace(/^installed (?:at )?/, ""),
      available: check.available === undefined ? "?" : packageVersionLabel(check.available, check.availableCommit),
      status: packageStatusLabel(check.status),
      reason: check.reason ?? "the host reports no usable version evidence",
    });
  }
  return { results, rows, refresh, apps, packages, appError, packageError, checkedAt: (options.now ?? Date.now)() };
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

/** An update plan for one recorded Package, with the receipt state the preview must show. */
export interface PreparedPackagePlan {
  readonly plan: PackageLifecyclePlan;
  readonly approval: PackageApprovalStatus;
}

export interface PreparedUpdates {
  readonly groups: readonly PreparedUpdateGroup[];
  /** Core used to execute the previewed App plans, absent for Skill-only data. */
  readonly apps?: AppOperations;
  /** Loaded-check-bound lifecycle plans which passed preview. */
  readonly appPlans: readonly AppLifecyclePlan[];
  /** Independent App planning errors retained for the combined summary. */
  readonly appFailures: readonly string[];
  /** Package operations bound to the check that produced the rows. */
  readonly packages?: PackageOperations;
  /** Package update plans, each with the state of its action-specific receipt. */
  readonly packagePlans?: readonly PreparedPackagePlan[];
  readonly packageFailures: readonly string[];
  /** What applying does, item by item, plus what could not be previewed. */
  readonly document: PreviewDocument;
  /** Items whose preview succeeded, across scopes; only these are applied. */
  readonly applicable: readonly (UpdateBatchAssessmentItem | AppLifecyclePlan | PackageLifecyclePlan)[];
  readonly failures: readonly UpdatePreviewFailure[];
  /** Non-canonical locations, per scope, that need their own explicit confirmation. */
  readonly nonCanonicalPaths: readonly ScopedPath[];
}

const PROJECT_WARNING = /^ {2}WARNING: /u;

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function appPreviewItem(plan: AppLifecyclePlan): PreviewItem {
  const rows: PreviewRow[] = [];
  if (plan.argv) {
    rows.push({ kind: "command", argv: plan.argv, cwd: plan.cwd, ...(plan.executable === undefined ? {} : { executable: plan.executable }) });
    if (plan.executable === undefined) rows.push({ kind: "warning", text: `${quoteText(plan.argv[0]!)} not found in PATH` });
  } else {
    rows.push({ kind: "field", label: "Working directory", value: plan.cwd });
  }
  if (plan.manual) rows.push({ kind: "field", label: "Manual", value: plan.manual });
  if (plan.warning) rows.push({ kind: "warning", text: plan.warning });
  return {
    title: plan.entry.recipe?.name ?? plan.entry.file,
    version: { from: plan.previousVersion ?? "unknown", to: plan.latestVersion ?? "unknown" },
    rows,
  };
}

/** The frozen plan with every fact the approval covers: origin, inventory, commands, blast radius and approval state. */
function packagePreviewItem(row: PackageUpdateRow, { plan, approval }: PreparedPackagePlan): PreviewItem {
  const { descriptor, selection } = plan;
  const rows: PreviewRow[] = [
    { kind: "field", label: "Coordinates", value: displayPackageSelection(selection) },
    { kind: "field", label: "Origin", value: `manifest ${plan.origin.manifestDigest.slice(0, 12)}${plan.origin.resolvedCommit === undefined ? "" : `  commit ${plan.origin.resolvedCommit.slice(0, 7)}`}` },
    { kind: "field", label: `Components (${descriptor.components.length})`, value: "" },
    ...descriptor.components.map((component): PreviewRow => ({ kind: "text", text: describePackageComponent(component), indent: 1 })),
  ];
  if (plan.commands.length === 0) {
    rows.push({ kind: "text", text: "This action runs no host command." }, { kind: "field", label: "Working directory", value: plan.cwd });
  }
  plan.commands.forEach((command, position) => rows.push(
    { kind: "field", label: `Step ${position + 1}`, value: command.purpose },
    { kind: "command", argv: [command.executable, ...command.args], executable: command.resolvedPath ?? command.executable, cwd: plan.cwd },
  ));
  rows.push(
    { kind: "field", label: "Blast radius", value: plan.affects.map((coordinates) => displayPackageCoordinates(selection.source, coordinates)).join(", ") },
    { kind: "field", label: "Approval", value: approval },
    ...plan.warnings.map((warning): PreviewRow => ({ kind: "warning", text: warning })),
    ...(approval === "needs approval" ? [{ kind: "text" as const, text: "This apply approves the declaration above." }] : []),
  );
  return {
    title: descriptor.name,
    detail: selection.host,
    version: { from: recordedVersionLabel(row.check.installed), to: packageVersionLabel(descriptor.version) },
    rows,
  };
}

/** Plan step: previews the selection from the assessed snapshots, scope by scope. Changes nothing. */
export async function prepareUpdates(
  data: UpdatesData,
  selected: readonly UpdateRow[],
): Promise<PreparedUpdates> {
  const groups: PreparedUpdateGroup[] = [];
  const appPlans: AppLifecyclePlan[] = [];
  const appFailures: string[] = [];
  const packagePlans: PreparedPackagePlan[] = [];
  const packageFailures: string[] = [];
  const failures: UpdatePreviewFailure[] = [];
  const context: string[] = [];
  const warnings: string[] = [];
  const skillItems: PreviewItem[] = [];
  const appItems: PreviewItem[] = [];
  const packageItems: PreviewItem[] = [];
  for (const { scope, loaded } of data.results) {
    const rows = selected.filter((row): row is SkillUpdateRow => row.kind === "skill" && row.scope === scope);
    if (!loaded || rows.length === 0) continue;
    const outcome = await previewUpdateCandidates(rows.map((row) => row.item), loaded.context);
    for (const line of loaded.projectTarget) {
      if (PROJECT_WARNING.test(line)) warnings.push(line.replace(PROJECT_WARNING, ""));
      else context.push(line);
    }
    for (const plan of outcome.plans) {
      const row = rows.find((candidate) => candidate.item === plan.item);
      const item = skillUpdatePreviewItem(plan, scope, loaded.context.projectRoot, "prompt");
      skillItems.push(row === undefined ? item : { ...item, version: { from: row.installed, to: row.available } });
    }
    failures.push(...outcome.failures);
    groups.push({
      scope,
      loaded,
      applicable: outcome.plans.map((plan) => plan.item),
      nonCanonicalPaths: outcome.nonCanonicalPaths,
      overwriteShown: new Set(outcome.plans.filter((plan) => plan.overwriteRequired).map((plan) => plan.item.id)),
    });
  }
  for (const row of selected) {
    if (row.kind !== "app" || !data.apps) continue;
    try {
      const plan = await data.apps.planLifecycle(row.check.entry, "update", undefined, row.check);
      appPlans.push(plan);
      appItems.push(appPreviewItem(plan));
    } catch (error) {
      appFailures.push(`Failed ${row.path}: preview failed: ${errorText(error)}`);
    }
  }
  for (const row of selected) {
    if (row.kind !== "package" || !data.packages) continue;
    try {
      const plan = await data.packages.planLifecycle(row.check.installed.selection, "update");
      const approval = await data.packages.approvalStatus(row.check.installed.selection, "update");
      packagePlans.push({ plan, approval });
      packageItems.push(packagePreviewItem(row, { plan, approval }));
    } catch (error) {
      packageFailures.push(`Failed ${row.path}: preview failed: ${errorText(error)}`);
    }
  }
  const applicable = [...groups.flatMap((group) => group.applicable), ...appPlans, ...packagePlans.map(({ plan }) => plan)];
  const sections = [
    { heading: "SKILLS", items: skillItems, noun: "Skill" },
    { heading: "APPS", items: appItems, noun: "App" },
    { heading: "PACKAGES", items: packageItems, noun: "Package" },
  ].filter(({ items }) => items.length > 0);
  const environments = new Set([...appPlans, ...packagePlans.map(({ plan }) => plan)].map((plan) => plan.environment));
  return {
    groups, apps: data.apps, appPlans, appFailures,
    packages: data.packages, packagePlans, packageFailures,
    document: {
      action: `Apply ${counted(applicable.length, "update")}`,
      summary: sections.map(({ items, noun }) => counted(items.length, noun)).join(" · "),
      context: [...context, ...[...environments].map((environment) => `Environment: ${environment}`)],
      warnings,
      sections: sections.map(({ heading, items }) => ({ heading, items })),
      failures: [
        ...failures.map(({ item, message }) => `${item.selection.path}: ${message}`),
        ...appFailures,
        ...packageFailures,
      ],
    },
    applicable,
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
 * confirmManual pauses for manual completion, showing the fallback reason. A false
 * answer (or absent callback) cancels and clears pending update evidence.
 * A Skill that became locally modified after the preview fails instead of being overwritten.
 */
export async function runUpdates(
  prepared: PreparedUpdates,
  confirmedPaths: readonly ScopedPath[],
  confirmManual?: (plan: AppLifecyclePlan, reason: string | undefined) => Promise<boolean>,
  /** Called before each Skill, App and Package runs, numbered across the whole batch. */
  onProgress?: (event: FlowProgress) => void,
): Promise<UpdateOutcome> {
  const updated: string[] = [];
  const failedLines: string[] = [];
  const packagePlans = prepared.packagePlans ?? [];
  const total = prepared.groups.reduce((sum, group) => sum + group.applicable.length, 0) + prepared.appPlans.length + packagePlans.length;
  let position = 0;
  const started = (kind: FlowProgress["kind"], name: string) => {
    position += 1;
    onProgress?.({ kind, name, position, total, verb: "Updating" });
  };
  for (const group of prepared.groups) {
    const result = await applyConfirmedUpdates(
      group.applicable,
      { ...group.loaded.context, onItem: (item) => started("skill", item.selection.path) },
      confirmedPaths
        .filter((confirmed) => confirmed.scope === group.scope && group.nonCanonicalPaths.includes(confirmed.path))
        .map((confirmed) => confirmed.path),
      group.overwriteShown,
    );
    updated.push(...result.updated.map((item) => `Updated ${item.selection.path}`));
    failedLines.push(...result.failed.map((item) => `Failed ${item.selection.path}: ${item.error ?? "unknown error"}`));
  }
  for (const plan of prepared.appPlans) {
    started("app", plan.entry.recipe!.name);
    const name = `App: ${plan.entry.recipe!.name}`;
    try {
      const apps = prepared.apps;
      if (!apps) throw new Error("App operations unavailable; check again");
      let result = await apps.executeLifecycle(plan, true);
      if (result.status === "manual required") {
        if (!await confirmManual?.(plan, result.reason)) {
          await apps.cancelManual(plan);
          failedLines.push(`Cancelled ${name}${result.reason ? `: ${result.reason}` : ""}`);
          continue;
        }
        result = await apps.completeManual(plan, true);
      }
      if (result.status === "failed") failedLines.push(`Failed ${name}: ${result.reason}`);
      else updated.push(`Updated ${name}: installed ${result.previousVersion} -> ${result.installedVersion} (latest ${result.latestVersion ?? "unknown"})`);
    } catch (error) {
      failedLines.push(`Failed ${name}: ${errorText(error)}`);
    }
  }
  for (const { plan, approval } of packagePlans) {
    started("package", plan.descriptor.name);
    const name = `Package: ${plan.descriptor.name} (${plan.selection.host}) from ${displayPackageSelection(plan.selection)}`;
    try {
      const packages = prepared.packages;
      if (!packages) throw new Error("Package operations unavailable; check again");
      if (approval === "needs approval") await packages.approve(plan.selection, plan.action);
      const result = await packages.executeLifecycle(plan, true);
      if (result.status === "updated") {
        updated.push(`Updated ${name}: ${installedEvidenceLabel(result.previous)} -> ${installedEvidenceLabel(result.verified)}`);
      } else if (result.status === "failed" || result.status === "stale plan" || result.status === "manual required") {
        failedLines.push(`Failed ${name}: ${result.reason}`);
      } else {
        failedLines.push(`Failed ${name}: unexpected result ${JSON.stringify(result.status)}`);
      }
    } catch (error) {
      failedLines.push(`Failed ${name}: ${errorText(error)}`);
    }
  }
  failedLines.push(...prepared.appFailures);
  failedLines.push(...prepared.packageFailures);
  const previewFailed = prepared.failures.map(
    ({ item, message }) => `Failed ${item.selection.path}: preview failed: ${message}`,
  );
  const failed = failedLines.length + previewFailed.length;
  return {
    failed,
    lines: [...updated, ...failedLines, ...previewFailed, `Update summary: ${updated.length} updated, ${failed} failed`],
  };
}
