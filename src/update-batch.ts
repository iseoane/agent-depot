import {
  parseProjectManifest,
  type ProjectManifest,
  type ProjectSkillSelection,
  type ProjectSource,
  type ResolvedVersionEvidence,
} from "./project-manifest.js";
import {
  resolveProjectSource,
  type Source,
} from "./sources.js";
import {
  skillTreeBaseline,
  type SkillTreeFile,
  type SourceSkillTreeSnapshot,
} from "./skill-discovery.js";

export type UpdateBatchAssessmentStatus = "updateable" | "current" | "unknown";

/** A read-only snapshot seam for batch assessment; it never executes update methods. */
export interface UpdateBatchSnapshotAccess {
  readonly readSkillTreeSnapshot?: (source: Source, skillPath: string) => Promise<SourceSkillTreeSnapshot>;
  readonly readSkillTree?: (source: Source, skillPath: string) => Promise<readonly SkillTreeFile[]>;
}

export interface UpdateBatchAssessmentOptions {
  /** Resolves manifest identity without refreshing or mutating a Source. */
  readonly resolveSource?: (source: ProjectSource) => Source | Promise<Source>;
  /** Reads the current Source tree. Prefer the combined snapshot method. */
  readonly sourceAccess: UpdateBatchSnapshotAccess;
}

export interface UpdateBatchAssessmentItem {
  /** Stable Source/path identity used for subset selection. */
  readonly id: string;
  readonly index: number;
  readonly selection: ProjectSkillSelection;
  readonly source?: Source;
  readonly status: UpdateBatchAssessmentStatus;
  readonly reason: string;
  /** Immutable Source tree captured for the eventual update; never reread during apply. */
  readonly currentSnapshot?: SourceSkillTreeSnapshot;
  /** Current content identity captured from the same snapshot as currentVersion. */
  readonly currentBaseline?: ReturnType<typeof skillTreeBaseline>;
  /** Current trustworthy Source version captured from the same snapshot as the tree. */
  readonly currentVersion?: ResolvedVersionEvidence;
}

const immutableAssessmentSnapshots = new WeakMap<UpdateBatchAssessmentItem, SourceSkillTreeSnapshot>();

export interface UpdateBatchAssessment {
  readonly items: readonly UpdateBatchAssessmentItem[];
  readonly updateable: readonly UpdateBatchAssessmentItem[];
  readonly current: readonly UpdateBatchAssessmentItem[];
  readonly unknown: readonly UpdateBatchAssessmentItem[];
}

export type UpdateBatchSelection =
  | "all"
  | readonly (string | number)[]
  | { readonly mode: "all" }
  | { readonly mode: "subset"; readonly ids: readonly (string | number)[] };

export class UpdateBatchSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateBatchSelectionError";
  }
}

/**
 * Assesses every installed selection against a separately captured current
 * Source snapshot. A missing or untrusted version is never promoted to an
 * updateable result.
 */
export async function assessUpdateBatch(
  value: ProjectManifest | readonly ProjectSkillSelection[],
  options: UpdateBatchAssessmentOptions,
): Promise<UpdateBatchAssessment> {
  const rawSelections: readonly unknown[] = Array.isArray(value)
    ? value
    : parseProjectManifest(value).skills;
  const resolveSource = options.resolveSource ?? resolveProjectSource;
  const items = await Promise.all(rawSelections.map(async (rawSelection, index) => {
    const parsed = parseRuntimeSelection(rawSelection);
    if (!parsed.selection) {
      return malformedSelectionAssessment(rawSelection, index, parsed.reason);
    }
    return assessSelection(parsed.selection, index, resolveSource, options.sourceAccess);
  }));
  const frozenItems = Object.freeze(items);
  return Object.freeze({
    items: frozenItems,
    updateable: Object.freeze(items.filter((item) => item.status === "updateable")),
    current: Object.freeze(items.filter((item) => item.status === "current")),
    unknown: Object.freeze(items.filter((item) => item.status === "unknown")),
  });
}

/** Selects all updateable entries or validates an explicit updateable subset. */
export function selectUpdateBatch(
  assessment: UpdateBatchAssessment,
  request: UpdateBatchSelection,
): readonly UpdateBatchAssessmentItem[] {
  let ids: readonly (string | number)[];
  if (request === "all") {
    return assessment.updateable;
  }
  if (Array.isArray(request)) {
    ids = request;
  } else if (!isModeSelection(request)) {
    throw new UpdateBatchSelectionError("Update batch selection must specify mode 'all' or a subset of ids");
  } else {
    const candidate = request as unknown as { readonly mode?: unknown; readonly ids?: unknown };
    if (candidate.mode === "all") {
      return assessment.updateable;
    }
    if (candidate.mode === "subset" && Array.isArray(candidate.ids)) {
      ids = candidate.ids;
    } else {
      throw new UpdateBatchSelectionError("Update batch selection must specify mode 'all' or a subset of ids");
    }
  }

  if (ids.length === 0) {
    throw new UpdateBatchSelectionError("An update subset must contain at least one Skill");
  }

  const updateable = new Map(assessment.updateable.map((item) => [item.id, item]));
  const byIndex = new Map(assessment.updateable.map((item) => [item.index, item]));
  const selected: UpdateBatchAssessmentItem[] = [];
  const seen = new Set<string>();
  for (const requested of ids) {
    const item = typeof requested === "number"
      ? byIndex.get(requested)
      : updateable.get(requested);
    if (!item) {
      const known = assessment.items.find((candidate) => candidate.id === requested || candidate.index === requested);
      if (known?.status === "unknown") {
        throw new UpdateBatchSelectionError(`Skill ${JSON.stringify(requested)} has unknown version status and is not updateable`);
      }
      if (known?.status === "current") {
        throw new UpdateBatchSelectionError(`Skill ${JSON.stringify(requested)} has no available update`);
      }
      throw new UpdateBatchSelectionError(`Unknown update batch selection ${JSON.stringify(requested)}`);
    }
    if (seen.has(item.id)) {
      throw new UpdateBatchSelectionError(`Update batch selection contains duplicate Skill ${JSON.stringify(requested)}`);
    }
    seen.add(item.id);
    selected.push(item);
  }
  return Object.freeze(selected);
}

/** Alias that makes the assessment operation discoverable to embedders. */
export const assessAvailableUpdates = assessUpdateBatch;

async function assessSelection(
  selection: ProjectSkillSelection,
  index: number,
  resolveSource: (source: ProjectSource) => Source | Promise<Source>,
  sourceAccess: UpdateBatchSnapshotAccess,
): Promise<UpdateBatchAssessmentItem> {
  const id = updateBatchItemId(selection);
  const base = { id, index, selection };
  if (!selection.installation) {
    return Object.freeze({
      ...base,
      status: "unknown" as const,
      reason: "The Skill has no installed baseline or resolved version evidence",
    });
  }

  let source: Source;
  try {
    source = await resolveSource(selection.source);
  } catch (error) {
    return Object.freeze({
      ...base,
      status: "unknown" as const,
      reason: `The current Source could not be resolved: ${errorMessage(error)}`,
    });
  }

  let snapshot: SourceSkillTreeSnapshot;
  try {
    snapshot = await readCurrentSnapshot(sourceAccess, source, selection.path);
    assertValidSnapshot(snapshot);
    const currentBaseline = skillTreeBaseline(snapshot.files);
    const currentVersion = trustworthyVersion(source, snapshot.resolvedVersion);
    const installedVersion = trustworthyVersionForSelection(source, selection.installation.resolvedVersion);
    const evidence = assessEvidence(selection, installedVersion, currentVersion, currentBaseline);
    const item = Object.freeze({
      ...base,
      source,
      status: evidence.status,
      reason: evidence.reason,
      currentSnapshot: freezeSnapshot(snapshot),
      currentBaseline,
      ...(currentVersion === undefined ? {} : { currentVersion }),
    });
    // Keep a second private copy because Uint8Array contents remain mutable
    // even when their containing object is frozen.
    immutableAssessmentSnapshots.set(item, freezeSnapshot(snapshot));
    return item;
  } catch (error) {
    return Object.freeze({
      ...base,
      source,
      status: "unknown" as const,
      reason: `The current Source snapshot could not be assessed: ${errorMessage(error)}`,
    });
  }
}

function isModeSelection(
  value: unknown,
): value is { readonly mode?: unknown; readonly ids?: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readCurrentSnapshot(
  sourceAccess: UpdateBatchSnapshotAccess,
  source: Source,
  skillPath: string,
): Promise<SourceSkillTreeSnapshot> {
  if (sourceAccess.readSkillTreeSnapshot) {
    return sourceAccess.readSkillTreeSnapshot(source, skillPath);
  }
  if (sourceAccess.readSkillTree) {
    return { files: await sourceAccess.readSkillTree(source, skillPath) };
  }
  throw new Error("the configured Source access does not provide a Skill tree snapshot reader");
}

function assessEvidence(
  selection: ProjectSkillSelection,
  installedVersion: ResolvedVersionEvidence | undefined,
  currentVersion: ResolvedVersionEvidence | undefined,
  currentBaseline: ReturnType<typeof skillTreeBaseline>,
): { readonly status: UpdateBatchAssessmentStatus; readonly reason: string } {
  if (currentVersion === undefined) {
    return {
      status: "unknown",
      reason: "The current Source snapshot has no trustworthy resolved version evidence",
    };
  }
  if (installedVersion === undefined) {
    return {
      status: "unknown",
      reason: "The installed Skill has no trustworthy resolved version evidence",
    };
  }

  if (selection.version.policy === "fixed") {
    const currentTarget = versionValue(currentVersion);
    if (currentTarget !== selection.version.version) {
      return {
        status: "unknown",
        reason: `The current Source resolved to ${JSON.stringify(currentTarget)}, not the fixed target ${JSON.stringify(selection.version.version)}`,
      };
    }
    if (versionValue(installedVersion) !== selection.version.version) {
      return {
        status: "updateable",
        reason: "The installed Skill is behind its fixed version target",
      };
    }
  } else if (!sameVersion(installedVersion, currentVersion)) {
    return {
      status: "updateable",
      reason: "A newer resolved version is available for the latest policy",
    };
  }

  const installedBaseline = selection.installation?.baseline;
  if (!installedBaseline) {
    return {
      status: "unknown",
      reason: "The installed Skill has no trustworthy content baseline",
    };
  }
  if (installedBaseline.digest !== currentBaseline.digest) {
    return {
      status: "updateable",
      reason: "The current Source snapshot differs from the installed content baseline",
    };
  }
  return {
    status: "current",
    reason: selection.version.policy === "fixed"
      ? "The installed Skill matches its fixed version and content baseline"
      : "The installed Skill matches the current latest version and content baseline",
  };
}

function parseRuntimeSelection(
  value: unknown,
): { readonly selection?: ProjectSkillSelection; readonly reason: string } {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the selection must be an object");
    }
    const candidate = value as Record<string, unknown>;
    const source = candidate.source;
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("the selection Source must be an object");
    }
    const sourceRecord = source as Record<string, unknown>;
    const projectSource = sourceRecord.kind === "builtin"
      ? { kind: "builtin", id: sourceRecord.id }
      : sourceRecord.kind === "external"
        ? {
          kind: "external",
          ...(typeof sourceRecord.url === "string" ? { url: sourceRecord.url } : {}),
          ...(typeof sourceRecord.path === "string" ? { path: sourceRecord.path } : {}),
          ...(sourceRecord.ref === undefined ? {} : { ref: sourceRecord.ref }),
        }
        : source;
    const version = candidate.version;
    const validationSource = sourceRecord.kind === "external" && typeof sourceRecord.url === "string" &&
      version !== null && typeof version === "object" && !Array.isArray(version) &&
      (version as Record<string, unknown>).policy === "fixed" && sourceRecord.ref === undefined
      ? { ...projectSource, ref: (version as Record<string, unknown>).version }
      : projectSource;
    const parsed = parseProjectManifest({
      version: 1,
      skills: [{ ...candidate, source: validationSource }],
    }).skills[0];
    if (!parsed) {
      return { reason: "the selection is missing" };
    }
    return { selection: parsed, reason: "" };
  } catch (error) {
    return { reason: errorMessage(error) };
  }
}

function malformedSelectionAssessment(
  value: unknown,
  index: number,
  reason: string,
): UpdateBatchAssessmentItem {
  return Object.freeze({
    id: runtimeSelectionId(value, index),
    index,
    selection: value as ProjectSkillSelection,
    status: "unknown" as const,
    reason: `The Skill selection is malformed: ${reason}`,
  });
}

function runtimeSelectionId(value: unknown, index: number): string {
  if (value !== null && typeof value === "object") {
    try {
      const candidate = value as { readonly source?: unknown; readonly path?: unknown };
      return JSON.stringify([candidate.source, candidate.path]);
    } catch {
      // Fall through to an index-based identity for cyclic or otherwise unserializable input.
    }
  }
  return `malformed:${index}`;
}

function assertValidSnapshot(value: unknown): asserts value is SourceSkillTreeSnapshot {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { readonly files?: unknown }).files)) {
    throw new Error("the Source snapshot must contain a files array");
  }
  for (const file of (value as { readonly files: readonly unknown[] }).files) {
    if (file === null || typeof file !== "object") {
      throw new Error("the Source snapshot contains a malformed Skill tree file");
    }
    const candidate = file as { readonly path?: unknown; readonly content?: unknown; readonly executable?: unknown };
    if (typeof candidate.path !== "string" || !(candidate.content instanceof Uint8Array) || typeof candidate.executable !== "boolean") {
      throw new Error("the Source snapshot contains a malformed Skill tree file");
    }
  }
}

function trustworthyVersion(source: Source, version: ResolvedVersionEvidence | undefined): ResolvedVersionEvidence | undefined {
  if (!version) return undefined;
  if (source.kind === "builtin" && version.kind === "builtin-package" && version.version.length > 0) return version;
  if (source.kind === "git" && version.kind === "git-commit" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(version.commit)) return version;
  return undefined;
}

function trustworthyVersionForSelection(source: Source, version: ResolvedVersionEvidence | undefined): ResolvedVersionEvidence | undefined {
  return trustworthyVersion(source, version);
}

function versionValue(version: ResolvedVersionEvidence): string {
  return version.kind === "builtin-package" ? version.version : version.commit;
}

function sameVersion(left: ResolvedVersionEvidence, right: ResolvedVersionEvidence): boolean {
  return left.kind === right.kind && versionValue(left) === versionValue(right);
}

export function updateBatchItemId(selection: Pick<ProjectSkillSelection, "source" | "path">): string {
  return JSON.stringify([selection.source, selection.path]);
}

export function immutableUpdateSnapshot(item: UpdateBatchAssessmentItem): SourceSkillTreeSnapshot | undefined {
  const snapshot = immutableAssessmentSnapshots.get(item);
  return snapshot === undefined ? undefined : freezeSnapshot(snapshot);
}

export function freezeSnapshot(snapshot: SourceSkillTreeSnapshot): SourceSkillTreeSnapshot {
  return Object.freeze({
    files: Object.freeze(snapshot.files.map((file) => Object.freeze({
      path: file.path,
      content: Uint8Array.from(file.content),
      executable: file.executable,
    }))),
    ...(snapshot.resolvedVersion === undefined ? {} : { resolvedVersion: Object.freeze({ ...snapshot.resolvedVersion }) }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
