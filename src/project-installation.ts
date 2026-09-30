import { chmod, lstat, mkdir, readFile, readlink, readdir, rename, rmdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import path from "node:path";

import type { ProjectHost, ProjectSkillSelection } from "./project-manifest.js";
import { compareSkillTrees, readExistingSkillTree } from "./skill-adoption.js";
import type { SkillTreeComparisonReason, SkillTreeFileSystem } from "./skill-adoption.js";
import { skillTreeBaseline } from "./skill-discovery.js";
import type { SkillTreeFile, SourceSkillTreeSnapshot } from "./skill-discovery.js";
import type { ResolvedVersionEvidence, SkillInstallationBaseline } from "./project-manifest.js";
import type { Source } from "./sources.js";

export interface ProjectSkillTreeAccess {
  readSkillTree(source: Source, skillPath: string): Promise<readonly SkillTreeFile[]>;
  /** Optional combined read that keeps version evidence tied to the returned bytes. */
  readSkillTreeSnapshot?(source: Source, skillPath: string): Promise<SourceSkillTreeSnapshot>;
}

export interface ProjectInstallationFileSystem {
  lstat(candidate: string): Promise<Stats>;
  mkdir(candidate: string): Promise<void>;
  writeFile(candidate: string, content: Uint8Array): Promise<void>;
  chmod(candidate: string, mode: number): Promise<void>;
  symlink(target: string, candidate: string, type: "dir"): Promise<void>;
  readlink(candidate: string): Promise<string>;
  rm(candidate: string): Promise<void>;
  rmdir(candidate: string): Promise<void>;
  /** Optional atomic move used by transactional updates. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Optional read methods used only when adopting an existing Skill. */
  readdir?(candidate: string): Promise<readonly string[]>;
  readFile?(candidate: string): Promise<Uint8Array>;
}

export interface ProjectSkillInstallationRequest {
  readonly selection: ProjectSkillSelection;
  /** Explicitly replace one untracked, real directory after a confirmed collision. */
  readonly overwrite?: boolean;
  /** The resolved Source used by the full Skill tree reader. */
  readonly source: Source;
  /**
   * The immutable tree shown in the caller's preview. When supplied, the
   * installer never reads the Source again, so installation cannot drift from
   * the bytes the user confirmed.
   */
  readonly previewTree?: readonly SkillTreeFile[];
  /** Read-only destination receipt captured before confirmation. */
  readonly inspection?: ProjectSkillInstallationInspection;
  /** Existing managed installation paths in this scope that must not overlap a replacement. */
  readonly protectedPaths?: readonly string[];
  /** Explicit compatibility evidence for the selected Skill. */
  readonly compatibleHosts?: readonly ProjectHost[];
  /**
   * Require the portable V1 format rule. Compatibility is derived from the
   * validated tree and its exclusions, not trusted from this flag alone.
   */
  readonly portableV1?: boolean;
  /** Optional per-host incompatibility details supplied by the compatibility adapter. */
  readonly compatibility?: Partial<Record<ProjectHost, boolean | string>>;
  /** Separate confirmation for creating an additional known Host location during adoption. */
  readonly confirmAdditionalHostExposure?: boolean;
  /** Version evidence captured from the same immutable Source snapshot as the tree. */
  readonly resolvedVersion?: ResolvedVersionEvidence;
}

export interface ProjectInstallationOptions {
  readonly projectRoot: string;
  readonly sourceAccess: ProjectSkillTreeAccess;
  readonly fileSystem?: ProjectInstallationFileSystem;
}

export type ProjectSkillInstallationCollisionReason =
  | SkillTreeComparisonReason
  | "not-directory"
  | "symbolic-link";

export interface ProjectSkillInstallationCollision {
  readonly path: string;
  readonly reason: ProjectSkillInstallationCollisionReason;
}

export interface ProjectSkillInstallationLocationInspection {
  readonly path: string;
  readonly status: "missing" | "identical" | "collision";
  readonly collision?: ProjectSkillInstallationCollision;
  /** Stable identity captured for the immediate pre-mutation race check. */
  readonly identity?: string;
  /** Content digest captured for the immediate pre-mutation race check. */
  readonly digest?: string;
}

/** Read-only destination receipt captured before installation confirmation. */
export interface ProjectSkillInstallationInspection {
  readonly canonicalPath: string;
  readonly claudePath: string;
  /** The existing location to adopt, or the canonical destination for a fresh install. */
  readonly targetPath: string;
  readonly locations: readonly ProjectSkillInstallationLocationInspection[];
  readonly collision?: ProjectSkillInstallationCollision;
}

export interface ProjectSkillInstallationResult {
  readonly skillName: string;
  readonly canonicalPath: string;
  /** Persistent copy of the replaced original tree; never pruned automatically. */
  readonly backupPath?: string;
  readonly claudePath?: string;
  readonly hosts: readonly ProjectHost[];
  readonly files: readonly string[];
  /** True when the existing project tree was adopted without writing it. */
  readonly adopted: boolean;
  /** Existing known project locations retained by an adoption. */
  readonly adoptedPaths: readonly string[];
  /** Content baseline for detecting later local modifications. */
  readonly baseline: SkillInstallationBaseline;
  /** Resolved Source evidence, when the caller supplied trustworthy evidence. */
  readonly resolvedVersion?: ResolvedVersionEvidence;
}

export interface ProjectSkillUpdateRequest {
  readonly selection: ProjectSkillSelection;
  /** The resolved Source used by the full Skill tree reader. */
  readonly source: Source;
  /** Immutable bytes captured during assessment; the Source is never reread. */
  readonly previewTree: readonly SkillTreeFile[];
  readonly resolvedVersion?: ResolvedVersionEvidence;
  /** Required only when the installed content differs from its recorded baseline. */
  readonly confirmOverwrite?: boolean;
}

export interface ProjectSkillUpdateTransaction {
  readonly result: ProjectSkillInstallationResult;
  rollback(): Promise<void>;
  /** Deletes the private backup after all surrounding persistence succeeds. */
  commit(): Promise<void>;
}

/**
 * Updates one already tracked Skill using a captured Source tree. The existing
 * directory is moved aside before the replacement is made, so a caller can
 * roll the filesystem back if persistence or another transaction step fails.
 */
export interface ProjectSkillUpdateInspection {
  readonly actualBaseline: SkillInstallationBaseline;
  readonly recordedBaseline?: SkillInstallationBaseline;
  readonly requiresOverwriteConfirmation: boolean;
}

/** Read-only receipt for removing one user-global Skill installation. */
export interface ProjectSkillRemovalInspection {
  readonly skillName: string;
  readonly paths: readonly string[];
  /** Digest captured during preflight and required to match before deletion. */
  readonly digest: string;
  readonly adopted: boolean;
  /** True when the content differs from its recorded baseline or no baseline exists. */
  readonly modified: boolean;
}

/** Refuses a removal batch whose selected filesystem targets overlap. */
export function assertNoOverlappingProjectSkillRemovalTargets(
  inspections: readonly ProjectSkillRemovalInspection[],
): void {
  const paths = inspections.flatMap((inspection) => inspection.paths);
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const left = path.resolve(paths[leftIndex]!);
      const right = path.resolve(paths[rightIndex]!);
      const relative = path.relative(left, right);
      const reverse = path.relative(right, left);
      if (relative === "" || reverse === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
        (!reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse))) {
        throw new ProjectInstallationError(
          "overlapping-targets",
          `Cannot remove selected Skills because removal targets overlap: ${JSON.stringify(left)} and ${JSON.stringify(right)}; no path was changed`,
        );
      }
    }
  }
}

export async function inspectProjectSkillRemoval(
  selection: ProjectSkillSelection,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillRemovalInspection> {
  if (!selection.installation) {
    throw new ProjectInstallationError("removal-unavailable", "Cannot remove a Skill without a recorded installation");
  }
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!fileSystem.readdir || !fileSystem.readFile) {
    throw new ProjectInstallationError("removal-unavailable", "Skill removal requires filesystem read support");
  }

  const projectRoot = path.resolve(options.projectRoot);
  const skillName = skillNameFromSelection(selection);
  const targetPath = resolveInstallationPath(projectRoot, selection.installation.path);
  await assertNoSymlinkComponents(projectRoot, fileSystem);
  await assertDirectory(projectRoot, fileSystem, "user-global root");
  await assertNoSymlinkAncestors(projectRoot, relativeSegments(projectRoot, targetPath), fileSystem);

  let targetInformation: Stats;
  try {
    targetInformation = await fileSystem.lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) {
      throw new ProjectInstallationError(
        "missing-installation",
        `The tracked Skill installation does not exist: ${targetPath}; no path was changed`,
      );
    }
    throw error;
  }
  assertRealDirectory(targetPath, targetInformation);
  const actualTree = await readExistingSkillTree(targetPath, selection.path, {
    lstat: fileSystem.lstat,
    readdir: fileSystem.readdir,
    readFile: fileSystem.readFile,
  });
  const actualBaseline = skillTreeBaseline(actualTree);
  const modified = selection.installation.baseline === undefined ||
    actualBaseline.digest !== selection.installation.baseline.digest;
  const paths = [targetPath];

  // A Claude exposure created by Agent Depot is removable only when it is the
  // exact relative symlink to this canonical installation. Never follow or
  // remove an unrelated path merely because the Skill selected Claude.
  const canonicalPath = path.join(projectRoot, ".agents", "skills", skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", skillName);
  if (selection.hosts.includes("claude") && targetPath === canonicalPath) {
    await assertNoSymlinkAncestors(projectRoot, relativeSegments(projectRoot, path.dirname(claudePath)), fileSystem);
    try {
      const claudeInformation = await fileSystem.lstat(claudePath);
      if (!claudeInformation.isSymbolicLink()) {
        throw new ProjectInstallationError(
          "unsafe-target",
          `Cannot remove the tracked Skill because its Claude location is not the managed symlink: ${claudePath}; no path was changed`,
        );
      }
      const target = await fileSystem.readlink(claudePath);
      if (path.resolve(path.dirname(claudePath), target) !== canonicalPath) {
        throw new ProjectInstallationError(
          "unsafe-target",
          `Cannot remove the tracked Skill because its Claude symlink does not point to the canonical installation: ${claudePath}; no path was changed`,
        );
      }
      paths.push(claudePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  return Object.freeze({
    skillName,
    paths: Object.freeze(paths),
    digest: actualBaseline.digest,
    adopted: selection.installation.adopted,
    modified,
  });
}

/** Removes a previously inspected user-global Skill after rechecking ownership. */
export async function removeProjectSkill(
  selection: ProjectSkillSelection,
  inspection: ProjectSkillRemovalInspection,
  options: ProjectInstallationOptions,
): Promise<void> {
  assertNoOverlappingProjectSkillRemovalTargets([inspection]);
  const current = await inspectProjectSkillRemoval(selection, options);
  if (current.skillName !== inspection.skillName ||
    current.paths.length !== inspection.paths.length ||
    current.paths.some((candidate, index) => candidate !== inspection.paths[index]) ||
    current.digest !== inspection.digest ||
    current.adopted !== inspection.adopted ||
    current.modified !== inspection.modified) {
    throw new ProjectInstallationError("removal-changed", "The inspected Skill removal target, digest, adoption, or modification state changed; no path was removed");
  }
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  for (const candidate of [...current.paths].reverse()) {
    await fileSystem.rm(candidate);
  }
}

export async function inspectProjectSkillUpdate(
  selection: ProjectSkillSelection,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillUpdateInspection> {
  if (!selection.installation) {
    throw new ProjectInstallationError("update-unavailable", "Cannot inspect a Skill without a recorded installation");
  }
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!fileSystem.readdir || !fileSystem.readFile) {
    throw new ProjectInstallationError("update-unavailable", "Skill update inspection requires filesystem read support");
  }
  const projectRoot = path.resolve(options.projectRoot);
  const targetPath = resolveInstallationPath(projectRoot, selection.installation.path);
  await assertNoSymlinkComponents(projectRoot, fileSystem);
  await assertDirectory(projectRoot, fileSystem, "project root");
  await assertNoSymlinkAncestors(projectRoot, relativeSegments(projectRoot, targetPath), fileSystem);
  const information = await fileSystem.lstat(targetPath);
  assertRealDirectory(targetPath, information);
  const actualTree = await readExistingSkillTree(targetPath, selection.path, {
    lstat: fileSystem.lstat,
    readdir: fileSystem.readdir,
    readFile: fileSystem.readFile,
  });
  const actualBaseline = skillTreeBaseline(actualTree);
  return Object.freeze({
    actualBaseline,
    ...(selection.installation.baseline === undefined ? {} : { recordedBaseline: selection.installation.baseline }),
    requiresOverwriteConfirmation: selection.installation.baseline === undefined ||
      actualBaseline.digest !== selection.installation.baseline.digest,
  });
}

export async function updateProjectSkill(
  request: ProjectSkillUpdateRequest,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillInstallationResult> {
  const transaction = await updateProjectSkillTransaction(request, options);
  await transaction.commit();
  return transaction.result;
}

export async function updateProjectSkillTransaction(
  request: ProjectSkillUpdateRequest,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillUpdateTransaction> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!fileSystem.rename) {
    throw new ProjectInstallationError("update-unavailable", "Transactional Skill updates require an atomic filesystem rename adapter");
  }
  if (!request.selection.installation) {
    throw new ProjectInstallationError("update-unavailable", "Cannot update a Skill without a recorded installation");
  }

  const skillName = skillNameFromSelection(request.selection);
  const projectRoot = path.resolve(options.projectRoot);
  const targetPath = resolveInstallationPath(projectRoot, request.selection.installation.path);
  await assertNoSymlinkComponents(projectRoot, fileSystem);
  await assertDirectory(projectRoot, fileSystem, "project root");
  await assertNoSymlinkAncestors(projectRoot, relativeSegments(projectRoot, targetPath), fileSystem);
  const targetInformation = await fileSystem.lstat(targetPath).catch((error: unknown) => {
    if (isMissing(error)) {
      throw new ProjectInstallationError("missing-installation", `The tracked Skill installation does not exist: ${targetPath}`);
    }
    throw error;
  });
  assertRealDirectory(targetPath, targetInformation);
  if (!fileSystem.readdir || !fileSystem.readFile) {
    throw new ProjectInstallationError("update-unavailable", "Transactional Skill updates require filesystem read support");
  }

  const actualTree = await readExistingSkillTree(targetPath, request.selection.path, {
    lstat: fileSystem.lstat,
    readdir: fileSystem.readdir,
    readFile: fileSystem.readFile,
  });
  const recordedBaseline = request.selection.installation.baseline;
  if (!recordedBaseline) {
    throw new ProjectInstallationError("unknown-baseline", "The tracked Skill has no content baseline; refusing to overwrite it");
  }
  const actualBaseline = skillTreeBaseline(actualTree);
  const locallyModified = actualBaseline.digest !== recordedBaseline.digest;
  if (locallyModified && request.confirmOverwrite !== true) {
    throw new ProjectInstallationError(
      "overwrite-confirmation-required",
      `The tracked Skill at ${JSON.stringify(targetPath)} differs from its recorded baseline; explicit overwrite confirmation is required and no path was changed`,
    );
  }

  const files = await readAndValidateTree({ ...request, previewTree: request.previewTree, portableV1: true }, skillName, options.sourceAccess);
  const parent = path.dirname(targetPath);
  await assertNoSymlinkAncestors(projectRoot, relativeSegments(projectRoot, parent), fileSystem);
  const stagePath = path.join(parent, `.agent-depot-update-${randomUUID()}`);
  const backupPath = path.join(parent, `.agent-depot-backup-${randomUUID()}`);
  let staged = false;
  let moved = false;
  let replacementIdentity: PathIdentity | undefined;
  try {
    await fileSystem.mkdir(stagePath);
    staged = true;
    await writeStagedTree(stagePath, files, fileSystem);
    await fileSystem.rename(targetPath, backupPath);
    moved = true;
    await fileSystem.rename(stagePath, targetPath);
    replacementIdentity = pathIdentity(await fileSystem.lstat(targetPath));
    staged = false;
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (staged) {
      await fileSystem.rm(stagePath).catch((cleanupError: unknown) => rollbackErrors.push(errorMessage(cleanupError)));
    }
    if (moved) {
      await fileSystem.rm(targetPath).catch((cleanupError: unknown) => rollbackErrors.push(errorMessage(cleanupError)));
      await fileSystem.rename(backupPath, targetPath).catch((cleanupError: unknown) => rollbackErrors.push(errorMessage(cleanupError)));
    }
    if (rollbackErrors.length > 0) {
      throw new ProjectInstallationError("rollback-failed", `${errorMessage(error)}; rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }

  const result = Object.freeze({
    skillName,
    canonicalPath: targetPath,
    hosts: Object.freeze([...request.selection.hosts]),
    files: Object.freeze(files.map((file) => file.relativePath)),
    adopted: request.selection.installation.adopted,
    adoptedPaths: Object.freeze([targetPath]),
    baseline: skillTreeBaseline(files.map((file) => file.source)),
    ...(request.resolvedVersion === undefined ? {} : { resolvedVersion: request.resolvedVersion }),
  });
  let state: "open" | "rolled-back" | "committed" = "open";
  return Object.freeze({
    result,
    rollback: async () => {
      if (state !== "open") return;
      state = "rolled-back";
      const errors: string[] = [];
      try {
        const current = await fileSystem.lstat(targetPath);
        if (!replacementIdentity || !samePathIdentity(replacementIdentity, pathIdentity(current))) {
          errors.push(`preserved concurrently replaced Skill at ${JSON.stringify(targetPath)}`);
        } else {
          await fileSystem.rm(targetPath);
        }
      } catch (error) {
        if (!isMissing(error)) errors.push(`could not remove replacement: ${errorMessage(error)}`);
      }
      if (errors.length === 0) {
        try {
          await fileSystem.rename!(backupPath, targetPath);
        } catch (error) {
          errors.push(`could not restore original Skill: ${errorMessage(error)}`);
        }
      }
      if (errors.length > 0) {
        throw new ProjectInstallationError("rollback-failed", `Rollback was incomplete: ${errors.join("; ")}`);
      }
    },
    commit: async () => {
      if (state !== "open") return;
      await fileSystem.rm(backupPath);
      state = "committed";
    },
  });
}

/** A successful install that can be reversed if a later transaction step fails. */
export interface ProjectSkillInstallationTransaction {
  readonly result: ProjectSkillInstallationResult;
  rollback(): Promise<void>;
}

export class ProjectInstallationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectInstallationError";
    this.code = code;
  }
}

const V1_HOSTS: readonly ProjectHost[] = ["pi", "claude", "codex", "opencode"];

const nodeFileSystem: ProjectInstallationFileSystem = {
  lstat,
  readdir: async (candidate) => readdir(candidate),
  readFile: async (candidate) => readFile(candidate),
  mkdir: async (candidate) => {
    await mkdir(candidate);
  },
  writeFile: async (candidate, content) => {
    await writeFile(candidate, content, { flag: "wx" });
  },
  chmod,
  symlink: async (target, candidate, type) => {
    await symlink(target, candidate, type);
  },
  rename,
  readlink,
  rm: async (candidate) => {
    await rm(candidate, { recursive: true, force: true });
  },
  rmdir,
};

/**
 * Classifies known installation locations without changing the filesystem.
 * Existing directories are read through lstat/readdir/readFile only; symlinks
 * are never followed while deciding whether a destination is safe.
 */
export async function inspectProjectSkillInstallation(
  request: ProjectSkillInstallationRequest,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillInstallationInspection> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!fileSystem.readdir || !fileSystem.readFile) {
    throw new ProjectInstallationError(
      "adoption-unavailable",
      "Cannot inspect an existing project Skill because directory and file reading are unavailable; retry with the standard filesystem adapter.",
    );
  }

  const skillName = skillNameFromSelection(request.selection);
  const projectRoot = path.resolve(options.projectRoot);
  await assertNoSymlinkComponents(projectRoot, fileSystem);
  await assertDirectory(projectRoot, fileSystem, "project root");
  const files = await readAndValidateTree(request, skillName, options.sourceAccess);
  validateCompatibility(request, skillName, files);

  const canonicalPath = path.join(projectRoot, ".agents", "skills", skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", skillName);
  await assertNoSymlinkAncestors(projectRoot, [".agents", "skills"], fileSystem);
  await assertNoSymlinkAncestors(projectRoot, [".claude", "skills"], fileSystem);

  const existingPaths: string[] = [];
  const locations: ProjectSkillInstallationLocationInspection[] = [];
  const expectedTree = files.map((file) => file.source);
  for (const candidate of [canonicalPath, claudePath]) {
    let information: Stats;
    try {
      information = await fileSystem.lstat(candidate);
    } catch (error) {
      if (isMissing(error)) {
        locations.push(Object.freeze({ path: candidate, status: "missing" }));
        continue;
      }
      throw error;
    }

    if (information.isSymbolicLink()) {
      if (candidate !== claudePath || !existingPaths.includes(canonicalPath)) {
        const collision = Object.freeze({ path: candidate, reason: "symbolic-link" as const });
        locations.push(Object.freeze({ path: candidate, status: "collision", collision }));
        continue;
      }
      let target: string;
      try {
        target = await fileSystem.readlink(candidate);
      } catch {
        const collision = Object.freeze({ path: candidate, reason: "symbolic-link" as const });
        locations.push(Object.freeze({ path: candidate, status: "collision", collision }));
        continue;
      }
      if (path.resolve(path.dirname(candidate), target) !== canonicalPath) {
        const collision = Object.freeze({ path: candidate, reason: "symbolic-link" as const });
        locations.push(Object.freeze({ path: candidate, status: "collision", collision }));
        continue;
      }
      existingPaths.push(candidate);
      locations.push(Object.freeze({ path: candidate, status: "identical" }));
      continue;
    }
    if (!information.isDirectory()) {
      const collision = Object.freeze({ path: candidate, reason: "not-directory" as const });
      locations.push(Object.freeze({ path: candidate, status: "collision", collision, identity: pathIdentityKey(pathIdentity(information)) }));
      continue;
    }

    let actualTree: readonly SkillTreeFile[];
    try {
      actualTree = await readExistingSkillTree(candidate, request.selection.path, {
        lstat: fileSystem.lstat,
        readdir: fileSystem.readdir,
        readFile: fileSystem.readFile,
      });
    } catch {
      const collision = Object.freeze({ path: candidate, reason: "unsafe-file" as const });
      locations.push(Object.freeze({ path: candidate, status: "collision", collision }));
      continue;
    }
    const comparison = compareSkillTrees(expectedTree, actualTree);
    const digest = skillTreeBaseline(actualTree).digest;
    const identity = pathIdentityKey(pathIdentity(information));
    if (!comparison.identical) {
      const collision = Object.freeze({
        path: candidate,
        reason: comparison.reason ?? "content-mismatch",
      });
      locations.push(Object.freeze({ path: candidate, status: "collision", collision, identity, digest }));
      continue;
    }
    existingPaths.push(candidate);
    locations.push(Object.freeze({ path: candidate, status: "identical", identity, digest }));
  }

  const firstExisting = locations.find((location) => location.status !== "missing");
  const targetPath = firstExisting?.path ?? canonicalPath;
  const collision = locations.find((location) => location.status === "collision")?.collision;
  return Object.freeze({
    canonicalPath,
    claudePath,
    targetPath,
    locations: Object.freeze(locations),
    ...(collision === undefined ? {} : { collision }),
  });
}

/** Validates the immutable preview tree and its requested Host compatibility without writing. */
export async function validateProjectSkillInstallationPreview(
  request: ProjectSkillInstallationRequest,
  sourceAccess: ProjectSkillTreeAccess,
): Promise<void> {
  const skillName = skillNameFromSelection(request.selection);
  const files = await readAndValidateTree(request, skillName, sourceAccess);
  validateCompatibility(request, skillName, files);
}

/**
 * Installs one selected Skill into a scope without consulting user-global
 * state. Existing identical paths are adopted; explicit overwrite is limited
 * to an inspected, untracked real directory and retains a persistent backup.
 */
export async function installProjectSkill(
  request: ProjectSkillInstallationRequest,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillInstallationResult> {
  const transaction = await installProjectSkillTransaction(request, options);
  return transaction.result;
}

/**
 * Installs one Skill and retains a transaction receipt for a surrounding
 * manifest/state transaction. Explicit overwrite moves the original directory
 * aside atomically so rollback can restore it if persistence fails.
 */
export async function installProjectSkillTransaction(
  request: ProjectSkillInstallationRequest,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillInstallationTransaction> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const skillName = skillNameFromSelection(request.selection);
  const projectRoot = path.resolve(options.projectRoot);
  await assertNoSymlinkComponents(projectRoot, fileSystem);
  await assertDirectory(projectRoot, fileSystem, "project root");
  // Explicit host evidence can reject before reading source bytes. The portable
  // baseline is different: its evidence is the validated tree itself, never a
  // caller's assertion alone.
  const hasDeclaredIncompatibility = Object.values(request.compatibility ?? {}).some((value) => value === false || typeof value === "string");
  const hasUnsupportedSelectedHost = request.compatibleHosts !== undefined &&
    request.selection.hosts.some((host) => !request.compatibleHosts?.includes(host));
  const earlyHosts = hasUnsupportedSelectedHost || hasDeclaredIncompatibility
    ? validateCompatibility(request, skillName, undefined)
    : request.portableV1 === true
      ? undefined
      : validateCompatibility(request, skillName, undefined);
  const files = await readAndValidateTree(request, skillName, options.sourceAccess);
  const baseline = skillTreeBaseline(files.map((file) => file.source));
  const hosts = earlyHosts ?? validateCompatibility(request, skillName, files);

  const canonicalSkillsPath = path.join(projectRoot, ".agents", "skills");
  const canonicalPath = path.join(canonicalSkillsPath, skillName);
  const claudeSkillsPath = path.join(projectRoot, ".claude", "skills");
  const claudePath = path.join(claudeSkillsPath, skillName);
  if (request.overwrite === true) {
    const inspection = request.inspection ?? await inspectProjectSkillInstallation(request, options);
    if (inspection.canonicalPath !== canonicalPath || inspection.claudePath !== claudePath) {
      throw new ProjectInstallationError(
        "target-changed",
        "The inspected overwrite receipt belongs to a different Skill destination; no path was changed",
      );
    }
    if (inspection.collision !== undefined) {
      assertOverwriteCollision(inspection);
      return overwriteProjectSkillTransaction(
        request,
        options,
        files,
        hosts,
        inspection,
      );
    }
  }
  const createdPaths: CreatedPath[] = [];
  const uncertainCreates = new Set<string>();

  try {
    // Check every existing ancestor before creating either host tree. This
    // prevents a later host check from following a pre-existing symlink after
    // the other host's directories have already been created.
    await assertNoSymlinkAncestors(projectRoot, [".agents", "skills", skillName], fileSystem);
    // A Claude Skill path may be the managed symlink to the canonical tree;
    // adoption validates that final component before following it.
    await assertNoSymlinkAncestors(projectRoot, [".claude", "skills"], fileSystem);

    const adoption = await adoptExistingProjectSkill(
      projectRoot,
      skillName,
      request.selection.path,
      files,
      hosts,
      fileSystem,
      request.confirmAdditionalHostExposure === true,
      createdPaths,
      uncertainCreates,
    );
    if (adoption) {
      return Object.freeze({
        result: Object.freeze({
          skillName,
          canonicalPath: adoption.canonicalPath,
          ...(hosts.includes("claude") ? { claudePath } : {}),
          hosts: Object.freeze([...hosts]),
          files: Object.freeze(files.map((file) => file.relativePath)),
          adopted: true,
          adoptedPaths: Object.freeze([...adoption.paths]),
          baseline,
          ...(request.resolvedVersion === undefined ? {} : { resolvedVersion: request.resolvedVersion }),
        }),
        rollback: async () => {
          const cleanupErrors = await rollbackCreatedPaths(createdPaths, uncertainCreates, fileSystem);
          if (cleanupErrors.length > 0) {
            throw new ProjectInstallationError(
              "rollback-failed",
              `Rollback was incomplete: ${cleanupErrors.join("; ")}`,
            );
          }
        },
      });
    }

    await ensureDirectoryTree(projectRoot, [".agents", "skills"], createdPaths, uncertainCreates, fileSystem);
    if (hosts.includes("claude")) {
      await ensureDirectoryTree(projectRoot, [".claude", "skills"], createdPaths, uncertainCreates, fileSystem);
    }

    await assertMissing(canonicalPath, fileSystem, canonicalPath);
    if (hosts.includes("claude")) {
      await assertMissing(claudePath, fileSystem, claudePath);
    }

    await createDirectory(canonicalPath, createdPaths, uncertainCreates, fileSystem);
    for (const file of files) {
      const destination = path.join(canonicalPath, ...file.relativePath.split("/"));
      await ensureDirectoryTree(canonicalPath, file.relativePath.split("/").slice(0, -1), createdPaths, uncertainCreates, fileSystem);
      uncertainCreates.add(destination);
      await fileSystem.writeFile(destination, file.source.content);
      const information = await fileSystem.lstat(destination);
      if (information.isSymbolicLink() || !information.isFile()) {
        throw new ProjectInstallationError("unsafe-target", `Installed file is not a regular file: ${destination}`);
      }
      createdPaths.push({ path: destination, kind: "file", identity: pathIdentity(information) });
      uncertainCreates.delete(destination);
      await fileSystem.chmod(destination, file.source.executable ? 0o755 : 0o644);
    }

    if (hosts.includes("claude")) {
      const linkTarget = path.relative(path.dirname(claudePath), canonicalPath);
      uncertainCreates.add(claudePath);
      try {
        await fileSystem.symlink(linkTarget, claudePath, "dir");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ProjectInstallationError(
          "claude-symlink-failed",
          `Cannot create the Claude Skill symlink at ${JSON.stringify(claudePath)}: ${reason}. ` +
          "Grant this process permission to create directory symlinks (on Windows, enable Developer Mode or the required symlink privilege) and retry. " +
          "No duplicate managed copy was created; the canonical installation was rolled back.",
        );
      }
      const information = await fileSystem.lstat(claudePath);
      if (!information.isSymbolicLink()) {
        throw new ProjectInstallationError("unsafe-target", `Claude installation path is not a symbolic link: ${claudePath}`);
      }
      createdPaths.push({ path: claudePath, kind: "symlink", identity: pathIdentity(information) });
      uncertainCreates.delete(claudePath);
    }

    const result = Object.freeze({
      skillName,
      canonicalPath,
      ...(hosts.includes("claude") ? { claudePath } : {}),
      hosts: Object.freeze([...hosts]),
      files: Object.freeze(files.map((file) => file.relativePath)),
      adopted: false,
      adoptedPaths: Object.freeze([]),
      baseline,
      ...(request.resolvedVersion === undefined ? {} : { resolvedVersion: request.resolvedVersion }),
    });
    return Object.freeze({
      result,
      rollback: async () => {
        const cleanupErrors = await rollbackCreatedPaths(createdPaths, uncertainCreates, fileSystem);
        if (cleanupErrors.length > 0) {
          throw new ProjectInstallationError(
            "rollback-failed",
            `Rollback was incomplete: ${cleanupErrors.join("; ")}`,
          );
        }
      },
    });
  } catch (error) {
    const cleanupErrors = await rollbackCreatedPaths(createdPaths, uncertainCreates, fileSystem);
    if (cleanupErrors.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      throw new ProjectInstallationError(
        "rollback-failed",
        `${original} Rollback was incomplete: ${cleanupErrors.join("; ")}`,
      );
    }
    throw error;
  }
}

function assertOverwriteCollision(inspection: ProjectSkillInstallationInspection): void {
  const collision = inspection.collision;
  if (!collision) return;
  if (collision.reason !== "missing-file" && collision.reason !== "extra-file" && collision.reason !== "content-mismatch") {
    throw new ProjectInstallationError(
      "unsafe-target",
      `Cannot overwrite ${JSON.stringify(collision.path)} because it is not an untracked real Skill directory; no path was changed`,
    );
  }

  const conflictingLocations = inspection.locations.filter((location) => location.status === "collision");
  if (conflictingLocations.length !== 1) {
    throw new ProjectInstallationError(
      "ambiguous-target",
      `Cannot overwrite Skill ${JSON.stringify(inspection.targetPath)} because its Host locations are ambiguous; no path was changed`,
    );
  }
  const otherExisting = inspection.locations.filter((location) => location.path !== collision.path && location.status !== "missing");
  if (otherExisting.some((location) => location.path !== inspection.claudePath || location.status !== "identical")) {
    throw new ProjectInstallationError(
      "ambiguous-target",
      `Cannot overwrite Skill ${JSON.stringify(inspection.targetPath)} because another Host location is also present; no path was changed`,
    );
  }
  // A real Claude directory is an intentional adoption when it is the only
  // existing location (see adoptExistingProjectSkill). It is ambiguous during
  // canonical replacement, however: leaving that duplicate directory in place
  // would make Claude continue reading the old bytes after the canonical move.
  const claudeLocation = inspection.locations.find((location) => location.path === inspection.claudePath);
  if (inspection.targetPath === inspection.canonicalPath && claudeLocation?.status === "identical" && claudeLocation.identity !== undefined) {
    throw new ProjectInstallationError(
      "ambiguous-target",
      `Cannot overwrite ${JSON.stringify(inspection.targetPath)} because the Claude location is a separate real directory rather than the managed symlink; no path was changed`,
    );
  }
}

function targetLocation(inspection: ProjectSkillInstallationInspection): ProjectSkillInstallationLocationInspection {
  return inspection.locations.find((location) => location.path === inspection.targetPath) ??
    (() => { throw new ProjectInstallationError("unsafe-target", `Cannot identify overwrite target ${inspection.targetPath}`); })();
}

function assertNoOverlappingOverwritePaths(targetPath: string, backupPath: string, protectedPaths: readonly string[]): void {
  const candidates = [targetPath, backupPath, ...protectedPaths].map((candidate) => path.resolve(candidate));
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (!pathsOverlap(candidates[leftIndex]!, candidates[rightIndex]!)) continue;
      throw new ProjectInstallationError(
        "managed-target",
        `Cannot overwrite ${JSON.stringify(targetPath)} because the installation or retained backup overlaps a managed Skill path; no path was changed`,
      );
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || reverse === "" ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
    (!reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse));
}

async function assertOverwriteInspectionUnchanged(
  request: ProjectSkillInstallationRequest,
  options: ProjectInstallationOptions,
  expected: ProjectSkillInstallationInspection,
): Promise<void> {
  const current = await inspectProjectSkillInstallation(request, options);
  const expectedTarget = targetLocation(expected);
  const currentTarget = targetLocation(current);
  const locationsMatch = current.locations.length === expected.locations.length && current.locations.every((location, index) => {
    const expectedLocation = expected.locations[index];
    return expectedLocation !== undefined &&
      location.path === expectedLocation.path &&
      location.status === expectedLocation.status &&
      location.collision?.reason === expectedLocation.collision?.reason &&
      location.identity === expectedLocation.identity &&
      location.digest === expectedLocation.digest;
  });
  if (current.canonicalPath !== expected.canonicalPath ||
    current.claudePath !== expected.claudePath ||
    current.targetPath !== expected.targetPath ||
    current.collision?.path !== expected.collision?.path ||
    current.collision?.reason !== expected.collision?.reason ||
    !locationsMatch ||
    currentTarget.identity !== expectedTarget.identity ||
    currentTarget.digest !== expectedTarget.digest) {
    throw new ProjectInstallationError(
      "target-changed",
      `The inspected overwrite target changed before mutation; no path was changed`,
    );
  }
}

async function assertBackupMatchesInspection(
  backupPath: string,
  request: ProjectSkillInstallationRequest,
  expected: ProjectSkillInstallationLocationInspection,
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  if (expected.identity === undefined || expected.digest === undefined) {
    throw new ProjectInstallationError(
      "backup-changed",
      `The retained backup at ${JSON.stringify(backupPath)} has no complete inspection receipt; the operation was stopped without deleting data`,
    );
  }
  const information = await fileSystem.lstat(backupPath);
  if (information.isSymbolicLink() || !information.isDirectory() || pathIdentityKey(pathIdentity(information)) !== expected.identity) {
    throw new ProjectInstallationError(
      "backup-changed",
      `The retained backup at ${JSON.stringify(backupPath)} changed identity after the original tree was moved; the operation was stopped without deleting data`,
    );
  }
  if (!fileSystem.readdir || !fileSystem.readFile) {
    throw new ProjectInstallationError("backup-changed", "The retained backup cannot be verified without directory and file reads; the operation was stopped without deleting data");
  }
  let tree: readonly SkillTreeFile[];
  try {
    tree = await readExistingSkillTree(backupPath, request.selection.path, {
      lstat: fileSystem.lstat,
      readdir: fileSystem.readdir,
      readFile: fileSystem.readFile,
    });
  } catch (error) {
    throw new ProjectInstallationError(
      "backup-changed",
      `The retained backup at ${JSON.stringify(backupPath)} could not be read safely (${errorMessage(error)}); the operation was stopped without deleting data`,
    );
  }
  const digest = skillTreeBaseline(tree).digest;
  if (digest !== expected.digest) {
    throw new ProjectInstallationError(
      "backup-changed",
      `The retained backup at ${JSON.stringify(backupPath)} differs from the preview receipt; the operation was stopped without deleting data`,
    );
  }
}

async function assertReplacementMatchesPreview(
  targetPath: string,
  request: ProjectSkillInstallationRequest,
  files: readonly ValidatedTreeFile[],
  expectedIdentity: PathIdentity,
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  const information = await fileSystem.lstat(targetPath);
  if (information.isSymbolicLink() || !information.isDirectory() || !samePathIdentity(expectedIdentity, pathIdentity(information))) {
    throw new ProjectInstallationError(
      "replacement-changed",
      `Preserved concurrently replaced Skill at ${JSON.stringify(targetPath)}; rollback did not delete it`,
    );
  }
  if (!fileSystem.readdir || !fileSystem.readFile) {
    throw new ProjectInstallationError("replacement-changed", "The replacement cannot be verified without directory and file reads; rollback did not delete it");
  }
  let tree: readonly SkillTreeFile[];
  try {
    tree = await readExistingSkillTree(targetPath, request.selection.path, {
      lstat: fileSystem.lstat,
      readdir: fileSystem.readdir,
      readFile: fileSystem.readFile,
    });
  } catch (error) {
    throw new ProjectInstallationError(
      "replacement-changed",
      `Preserved concurrently replaced Skill at ${JSON.stringify(targetPath)} (${errorMessage(error)}); rollback did not delete it`,
    );
  }
  const expectedDigest = skillTreeBaseline(files.map((file) => file.source)).digest;
  if (skillTreeBaseline(tree).digest !== expectedDigest) {
    throw new ProjectInstallationError(
      "replacement-changed",
      `Preserved concurrently modified Skill at ${JSON.stringify(targetPath)}; rollback did not delete it`,
    );
  }
}

async function overwriteProjectSkillTransaction(
  request: ProjectSkillInstallationRequest,
  options: ProjectInstallationOptions,
  files: readonly ValidatedTreeFile[],
  hosts: readonly ProjectHost[],
  inspection: ProjectSkillInstallationInspection,
): Promise<ProjectSkillInstallationTransaction> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!fileSystem.rename) {
    throw new ProjectInstallationError("overwrite-unavailable", "Explicit Skill overwrite requires an atomic filesystem rename adapter");
  }
  const targetPath = inspection.targetPath;
  const projectRoot = path.resolve(options.projectRoot);
  const parent = path.dirname(targetPath);
  await assertNoSymlinkAncestors(projectRoot, relativeSegments(projectRoot, parent), fileSystem);
  const stagePath = path.join(parent, `.agent-depot-overwrite-${randomUUID()}`);
  const backupPath = path.join(parent, `.agent-depot-backup-${randomUUID()}`);
  assertNoOverlappingOverwritePaths(targetPath, backupPath, request.protectedPaths ?? []);
  await assertMissing(stagePath, fileSystem, stagePath);
  await assertMissing(backupPath, fileSystem, backupPath);

  let stageCreated = false;
  let moved = false;
  let replacementInstalled = false;
  let replacementIdentity: PathIdentity | undefined;
  const exposureCreated: CreatedPath[] = [];
  const exposureUncertain = new Set<string>();

  const restore = async (): Promise<string[]> => {
    const errors: string[] = [];
    errors.push(...await rollbackCreatedPaths(exposureCreated, exposureUncertain, fileSystem));
    if (stageCreated) {
      await fileSystem.rm(stagePath).catch((error: unknown) => errors.push(`could not remove staging tree: ${errorMessage(error)}`));
    }
    if (moved) {
      if (replacementIdentity !== undefined) {
        try {
          await assertReplacementMatchesPreview(targetPath, request, files, replacementIdentity, fileSystem);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      } else if (replacementInstalled) {
        errors.push(`preserved replacement at ${JSON.stringify(targetPath)} because its identity could not be verified`);
      }
      if (errors.length === 0 && replacementIdentity !== undefined) {
        try {
          await assertBackupMatchesInspection(backupPath, request, targetLocation(inspection), fileSystem);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
      if (errors.length === 0 && replacementIdentity !== undefined) {
        // Recheck ownership immediately before the destructive remove. Portable
        // filesystem APIs do not provide a cross-process compare-and-swap, so a
        // writer can still race after this check; any observed identity/content
        // drift is nevertheless preserved and fails closed.
        try {
          const current = await fileSystem.lstat(targetPath);
          if (!samePathIdentity(replacementIdentity, pathIdentity(current))) {
            errors.push(`preserved concurrently replaced Skill at ${JSON.stringify(targetPath)}`);
          } else {
            await fileSystem.rm(targetPath);
          }
        } catch (error) {
          if (!isMissing(error)) errors.push(`could not remove replacement: ${errorMessage(error)}`);
        }
      }
      if (errors.length === 0) {
        await fileSystem.rename!(backupPath, targetPath).catch((error: unknown) => {
          errors.push(`could not restore original Skill: ${errorMessage(error)}`);
        });
      }
    }
    return errors;
  };

  try {
    await fileSystem.mkdir(stagePath);
    stageCreated = true;
    await writeStagedTree(stagePath, files, fileSystem);
    // Revalidate after all potentially slow staging work and immediately before
    // moving the user's original tree. The preview bytes are immutable and no
    // external installation method has run at this point.
    await assertOverwriteInspectionUnchanged(request, options, inspection);
    await fileSystem.rename(targetPath, backupPath);
    moved = true;
    // Rename preserves the original tree as a recovery boundary. Verify both
    // its native directory identity and its complete content receipt before the
    // staged tree is exposed at the installation path.
    await assertBackupMatchesInspection(backupPath, request, targetLocation(inspection), fileSystem);
    await fileSystem.rename(stagePath, targetPath);
    stageCreated = false;
    replacementInstalled = true;
    replacementIdentity = pathIdentity(await fileSystem.lstat(targetPath));

    const claudeLocation = inspection.locations.find((location) => location.path === inspection.claudePath);
    if (targetPath === inspection.canonicalPath && hosts.includes("claude") && claudeLocation?.status === "missing") {
      await ensureDirectoryTree(projectRoot, [".claude", "skills"], exposureCreated, exposureUncertain, fileSystem);
      const linkTarget = path.relative(path.dirname(inspection.claudePath), inspection.canonicalPath);
      exposureUncertain.add(inspection.claudePath);
      await fileSystem.symlink(linkTarget, inspection.claudePath, "dir");
      const linkInformation = await fileSystem.lstat(inspection.claudePath);
      if (!linkInformation.isSymbolicLink()) {
        throw new ProjectInstallationError("unsafe-target", `Claude installation path is not a symbolic link: ${inspection.claudePath}`);
      }
      exposureCreated.push({ path: inspection.claudePath, kind: "symlink", identity: pathIdentity(linkInformation) });
      exposureUncertain.delete(inspection.claudePath);
    }
  } catch (error) {
    const rollbackErrors = await restore();
    if (rollbackErrors.length > 0) {
      throw new ProjectInstallationError("rollback-failed", `${errorMessage(error)}; rollback was incomplete: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }

  const result = Object.freeze({
    skillName: skillNameFromSelection(request.selection),
    canonicalPath: targetPath,
    ...(hosts.includes("claude") ? { claudePath: inspection.claudePath } : {}),
    backupPath,
    hosts: Object.freeze([...hosts]),
    files: Object.freeze(files.map((file) => file.relativePath)),
    adopted: false,
    adoptedPaths: Object.freeze([]),
    baseline: skillTreeBaseline(files.map((file) => file.source)),
    ...(request.resolvedVersion === undefined ? {} : { resolvedVersion: request.resolvedVersion }),
  });
  let state: "open" | "rolled-back" = "open";
  return Object.freeze({
    result,
    rollback: async () => {
      if (state !== "open") return;
      state = "rolled-back";
      const rollbackErrors = await restore();
      if (rollbackErrors.length > 0) {
        throw new ProjectInstallationError("rollback-failed", `Rollback was incomplete: ${rollbackErrors.join("; ")}`);
      }
    },
  });
}

interface ValidatedTreeFile {
  readonly relativePath: string;
  readonly source: SkillTreeFile;
}

interface ExistingProjectSkillAdoption {
  readonly canonicalPath: string;
  readonly paths: readonly string[];
}

async function adoptExistingProjectSkill(
  projectRoot: string,
  skillName: string,
  sourceSkillPath: string,
  expectedFiles: readonly ValidatedTreeFile[],
  hosts: readonly ProjectHost[],
  fileSystem: ProjectInstallationFileSystem,
  confirmAdditionalHostExposure: boolean,
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
): Promise<ExistingProjectSkillAdoption | undefined> {
  const candidatePaths = [
    path.join(projectRoot, ".agents", "skills", skillName),
    path.join(projectRoot, ".claude", "skills", skillName),
  ];
  const canonicalPath = candidatePaths[0]!;
  const claudePath = candidatePaths[1]!;
  const existingPaths: string[] = [];
  const expectedTree = expectedFiles.map((file) => file.source);
  const treeAccess: SkillTreeFileSystem = {
    lstat: fileSystem.lstat,
    readdir: async (candidate) => {
      if (!fileSystem.readdir) {
        throw new ProjectInstallationError(
          "adoption-unavailable",
          "Cannot inspect an existing project Skill because directory reading is unavailable; retry with the standard filesystem adapter.",
        );
      }
      return fileSystem.readdir(candidate);
    },
    readFile: async (candidate) => {
      if (!fileSystem.readFile) {
        throw new ProjectInstallationError(
          "adoption-unavailable",
          "Cannot inspect an existing project Skill because file reading is unavailable; retry with the standard filesystem adapter.",
        );
      }
      return fileSystem.readFile(candidate);
    },
  };

  for (const candidate of candidatePaths) {
    let information: Stats;
    try {
      information = await fileSystem.lstat(candidate);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (information.isSymbolicLink()) {
      if (candidate !== claudePath) {
        throw new ProjectInstallationError(
          "unsafe-target",
          `Cannot inspect existing Skill at ${JSON.stringify(candidate)} because it is a symbolic link; no path was changed.`,
        );
      }
      await assertClaudeSymlinkTargetsCanonical(candidate, canonicalPath, existingPaths, fileSystem);
      existingPaths.push(candidate);
      continue;
    }
    if (!information.isDirectory()) {
      throw new ProjectInstallationError(
        "adoption-conflict",
        `Cannot adopt because the existing Skill path ${JSON.stringify(candidate)} is not a directory; explicit confirmation would be required to overwrite it, but this safe install flow has no overwrite operation. No path was changed.`,
      );
    }

    let actualTree: readonly SkillTreeFile[];
    try {
      actualTree = await readExistingSkillTree(candidate, sourceSkillPath, treeAccess);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProjectInstallationError(
        "unsafe-target",
        `Cannot safely inspect existing Skill at ${JSON.stringify(candidate)}: ${reason}. No path was changed.`,
      );
    }
    const comparison = compareSkillTrees(expectedTree, actualTree);
    if (!comparison.identical) {
      throw new ProjectInstallationError(
        "adoption-conflict",
        `Cannot adopt because an existing Skill already exists at ${JSON.stringify(candidate)} with different content (${comparison.reason}); explicit confirmation would be required to overwrite it, but this safe install flow has no overwrite operation. No path was changed.`,
      );
    }
    existingPaths.push(candidate);
  }

  if (existingPaths.length === 0) return undefined;

  const requiresCanonical = hosts.some((host) => host !== "claude");
  const requiresClaude = hosts.includes("claude");
  const missingClaude = requiresClaude && !existingPaths.includes(claudePath);
  if ((requiresCanonical && !existingPaths.includes(canonicalPath)) || missingClaude) {
    if (!confirmAdditionalHostExposure) {
      const missing = missingClaude ? "Claude exposure" : "another Host location";
      throw new ProjectInstallationError(
        "adoption-confirmation-required",
        `An identical Skill was found at ${JSON.stringify(existingPaths[0])}, but adding the missing ${missing} requires explicit confirmation; ` +
        "adoption will not create, move, or overwrite any path. Re-run with --confirm-additional-host and --yes.",
      );
    }
    if (!existingPaths.includes(canonicalPath)) {
      throw new ProjectInstallationError(
        "adoption-confirmation-required",
        `An identical Skill was found at ${JSON.stringify(existingPaths[0])}, but safely exposing it at another Host location would require moving or copying it; ` +
        "this operation does not move or duplicate adopted Skills, so no path was changed.",
      );
    }
    await ensureDirectoryTree(projectRoot, [".claude", "skills"], createdPaths, uncertainCreates, fileSystem);
    await assertMissing(claudePath, fileSystem, claudePath);
    const linkTarget = path.relative(path.dirname(claudePath), canonicalPath);
    uncertainCreates.add(claudePath);
    try {
      await fileSystem.symlink(linkTarget, claudePath, "dir");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProjectInstallationError(
        "claude-symlink-failed",
        `Cannot create the additional Claude Skill symlink at ${JSON.stringify(claudePath)}: ${reason}. No existing path was changed.`,
      );
    }
    const information = await fileSystem.lstat(claudePath);
    if (!information.isSymbolicLink()) {
      throw new ProjectInstallationError("unsafe-target", `Claude installation path is not a symbolic link: ${claudePath}`);
    }
    createdPaths.push({ path: claudePath, kind: "symlink", identity: pathIdentity(information) });
    uncertainCreates.delete(claudePath);
    existingPaths.push(claudePath);
  }

  const adoptedCanonicalPath = existingPaths.includes(canonicalPath) ? canonicalPath : claudePath;
  return Object.freeze({
    canonicalPath: adoptedCanonicalPath,
    paths: Object.freeze(existingPaths),
  });
}

async function assertClaudeSymlinkTargetsCanonical(
  claudePath: string,
  canonicalPath: string,
  existingPaths: readonly string[],
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  let target: string;
  try {
    target = await fileSystem.readlink(claudePath);
  } catch (error) {
    throw new ProjectInstallationError(
      "unsafe-target",
      `Cannot inspect the Claude Skill symlink at ${JSON.stringify(claudePath)}: ${errorMessage(error)}. No path was changed.`,
    );
  }
  const resolvedTarget = path.resolve(path.dirname(claudePath), target);
  if (resolvedTarget !== canonicalPath || !existingPaths.includes(canonicalPath)) {
    throw new ProjectInstallationError(
      "unsafe-target",
      `Cannot adopt the Claude Skill symlink at ${JSON.stringify(claudePath)} because it does not point to the existing canonical Skill; no path was changed.`,
    );
  }
}

async function readAndValidateTree(
  request: ProjectSkillInstallationRequest,
  skillName: string,
  sourceAccess: ProjectSkillTreeAccess,
): Promise<readonly ValidatedTreeFile[]> {
  const tree = request.previewTree ?? await sourceAccess.readSkillTree(request.source, request.selection.path);

  const prefix = `${request.selection.path}/`;
  const seen = new Set<string>();
  const validated: ValidatedTreeFile[] = [];
  for (const file of tree) {
    if (!file.path.startsWith(prefix)) {
      throw new ProjectInstallationError(
        "unsafe-skill-tree",
        `Skill ${JSON.stringify(skillName)} returned a file outside its selected directory: ${JSON.stringify(file.path)}`,
      );
    }
    const relativePath = file.path.slice(prefix.length);
    if (!isSafeRelativePath(relativePath) || seen.has(relativePath)) {
      throw new ProjectInstallationError(
        "unsafe-skill-tree",
        `Skill ${JSON.stringify(skillName)} returned an unsafe or duplicate file path: ${JSON.stringify(file.path)}`,
      );
    }
    seen.add(relativePath);
    validated.push({
      relativePath,
      source: Object.freeze({
        path: file.path,
        content: Uint8Array.from(file.content),
        executable: file.executable,
      }),
    });
  }
  if (!seen.has("SKILL.md")) {
    throw new ProjectInstallationError(
      "unsafe-skill-tree",
      `Skill ${JSON.stringify(skillName)} does not contain its required SKILL.md file`,
    );
  }
  if (request.portableV1 === true) {
    const excluded = validated.find((file) => portableV1ExcludedDirectory(file.relativePath));
    if (excluded) {
      throw new ProjectInstallationError(
        "incompatible-skill-tree",
        `Skill ${JSON.stringify(skillName)} contains ${JSON.stringify(excluded.relativePath)}, which is excluded by the portable V1 format rules`,
      );
    }
  }
  return Object.freeze(validated);
}

function skillNameFromSelection(selection: ProjectSkillSelection): string {
  const skillName = path.posix.basename(selection.path);
  if (!isSafeSegment(skillName)) {
    throw new ProjectInstallationError(
      "unsafe-skill-name",
      `Selected Skill path ${JSON.stringify(selection.path)} does not identify a safe Skill directory name`,
    );
  }
  return skillName;
}

function validateCompatibility(
  request: ProjectSkillInstallationRequest,
  skillName: string,
  files: readonly ValidatedTreeFile[] | undefined,
): readonly ProjectHost[] {
  const formatSupported = request.portableV1 === true
    ? files === undefined
      ? new Set(request.selection.hosts)
      : isPortableV1Tree(files) ? new Set(V1_HOSTS) : new Set<ProjectHost>()
    : new Set<ProjectHost>();
  const supported = request.compatibleHosts === undefined
    ? formatSupported
    : new Set(V1_HOSTS.filter((host) => formatSupported.has(host) && request.compatibleHosts?.includes(host)));
  const incompatible = request.selection.hosts.filter((host) => {
    const declared = request.compatibility?.[host];
    return !supported.has(host) || declared === false || typeof declared === "string";
  });
  if (incompatible.length > 0) {
    const host = incompatible[0];
    const declared = request.compatibility?.[host];
    const reason = typeof declared === "string"
      ? declared
      : request.compatibleHosts === undefined && request.portableV1 !== true
        ? "no compatibility evidence or explicit portable V1 baseline was supplied"
        : request.compatibleHosts === undefined
          ? "the Skill tree does not satisfy the portable V1 format rules"
          : `this Skill does not support the selected Host ${JSON.stringify(host)}`;
    throw new ProjectInstallationError(
      "incompatible-host",
      `Skill ${JSON.stringify(skillName)} is incompatible with Host ${JSON.stringify(host)}: ${reason}. ` +
      "Choose a compatible Host or remove the Host from the project selection; nothing was installed.",
    );
  }
  return Object.freeze([...request.selection.hosts]);
}

async function assertNoSymlinkComponents(
  candidate: string,
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  const parsed = path.parse(candidate);
  const relative = path.relative(parsed.root, candidate);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = parsed.root;

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const information = await fileSystem.lstat(current);
      if (information.isSymbolicLink()) {
        throw new ProjectInstallationError(
          "unsafe-project-root",
          `The project root contains a symbolic-link ancestor: ${current}`,
        );
      }
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
  }
}

async function assertDirectory(
  candidate: string,
  fileSystem: ProjectInstallationFileSystem,
  label: string,
): Promise<void> {
  try {
    const information = await fileSystem.lstat(candidate);
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw new ProjectInstallationError("unsafe-project-root", `The ${label} is not a real directory: ${candidate}`);
    }
  } catch (error) {
    if (isMissing(error)) {
      throw new ProjectInstallationError("missing-project-root", `The ${label} does not exist: ${candidate}`);
    }
    throw error;
  }
}

interface PathIdentity {
  readonly device: number;
  readonly inode: number;
  readonly birthtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly mode: number;
}

interface CreatedPath {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly identity: PathIdentity;
}

async function ensureDirectoryTree(
  root: string,
  segments: readonly string[],
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
  fileSystem: ProjectInstallationFileSystem,
): Promise<string> {
  let current = root;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      throw new ProjectInstallationError("unsafe-target", `Unsafe project installation path segment: ${segment}`);
    }
    current = path.join(current, segment);
    try {
      const information = await fileSystem.lstat(current);
      assertRealDirectory(current, information);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      uncertainCreates.add(current);
      await fileSystem.mkdir(current);
      const information = await fileSystem.lstat(current);
      assertRealDirectory(current, information);
      createdPaths.push({ path: current, kind: "directory", identity: pathIdentity(information) });
      uncertainCreates.delete(current);
    }
  }
  return current;
}

async function createDirectory(
  candidate: string,
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  uncertainCreates.add(candidate);
  await fileSystem.mkdir(candidate);
  const information = await fileSystem.lstat(candidate);
  assertRealDirectory(candidate, information);
  createdPaths.push({ path: candidate, kind: "directory", identity: pathIdentity(information) });
  uncertainCreates.delete(candidate);
}

function assertRealDirectory(candidate: string, information: Stats): void {
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new ProjectInstallationError("target-conflict", `Installation path is not a real directory: ${candidate}`);
  }
}

async function assertMissing(
  candidate: string,
  fileSystem: ProjectInstallationFileSystem,
  displayPath: string,
): Promise<void> {
  try {
    await fileSystem.lstat(candidate);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  throw new ProjectInstallationError(
    "target-conflict",
    `Cannot install because the target already exists at ${JSON.stringify(displayPath)}; explicit confirmation would be required to overwrite it, but this safe install flow has no overwrite operation. No path was changed.`,
  );
}

async function assertNoSymlinkAncestors(
  root: string,
  segments: readonly string[],
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  let current = root;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      throw new ProjectInstallationError("unsafe-target", `Unsafe project installation path segment: ${segment}`);
    }
    current = path.join(current, segment);
    try {
      const information = await fileSystem.lstat(current);
      if (information.isSymbolicLink()) {
        throw new ProjectInstallationError("unsafe-target", `Installation path contains a symbolic-link ancestor: ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
  }
}

async function rollbackCreatedPaths(
  createdPaths: readonly CreatedPath[],
  uncertainCreates: ReadonlySet<string>,
  fileSystem: ProjectInstallationFileSystem,
): Promise<string[]> {
  const errors: string[] = [];
  for (const created of [...createdPaths].reverse()) {
    try {
      const information = await fileSystem.lstat(created.path);
      if (!samePathIdentity(created.identity, pathIdentity(information))) {
        errors.push(`preserved concurrently replaced path ${JSON.stringify(created.path)}`);
        continue;
      }
      if (created.kind === "directory") {
        if (information.isSymbolicLink() || !information.isDirectory()) {
          errors.push(`preserved changed path ${JSON.stringify(created.path)}`);
          continue;
        }
        await fileSystem.rmdir(created.path);
      } else {
        await fileSystem.rm(created.path);
      }
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(`could not remove ${JSON.stringify(created.path)}: ${errorMessage(error)}`);
      }
    }
  }

  for (const candidate of uncertainCreates) {
    try {
      await fileSystem.lstat(candidate);
      errors.push(`could not verify ownership of ${JSON.stringify(candidate)}; it was preserved`);
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(`could not inspect uncertain path ${JSON.stringify(candidate)}: ${errorMessage(error)}`);
      }
    }
  }
  return errors;
}

function pathIdentity(information: Stats): PathIdentity {
  return {
    device: information.dev,
    inode: information.ino,
    birthtimeMs: information.birthtimeMs,
    ctimeMs: information.ctimeMs,
    size: information.size,
    mode: information.mode,
  };
}

function pathIdentityKey(identity: PathIdentity): string {
  // Rename may update ctime while preserving the native directory identity.
  // Use dev/inode when the platform provides them; only the fallback needs the
  // additional metadata because it has no native identity to compare.
  if (Number.isFinite(identity.device) && Number.isFinite(identity.inode) &&
    (identity.device !== 0 || identity.inode !== 0)) {
    return `native:${identity.device}:${identity.inode}`;
  }
  return `fallback:${identity.birthtimeMs}:${identity.size}:${identity.mode}`;
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  // Prefer native device/inode identity. The birth/ctime fallback supports
  // hosts where the native values are unavailable while still failing closed
  // when no stable identity can be established.
  if (Number.isFinite(left.device) && Number.isFinite(left.inode) &&
    (left.device !== 0 || left.inode !== 0)) {
    return left.device === right.device && left.inode === right.inode;
  }
  return Number.isFinite(left.birthtimeMs) && left.birthtimeMs > 0 &&
    left.birthtimeMs === right.birthtimeMs && left.ctimeMs === right.ctimeMs &&
    left.size === right.size && left.mode === right.mode;
}

async function writeStagedTree(
  stagePath: string,
  files: readonly ValidatedTreeFile[],
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const destination = path.join(stagePath, ...segments);
    await ensureDirectoryTree(stagePath, segments.slice(0, -1), [], new Set(), fileSystem);
    await fileSystem.writeFile(destination, file.source.content);
    const information = await fileSystem.lstat(destination);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new ProjectInstallationError("unsafe-target", `Updated file is not a regular file: ${destination}`);
    }
    await fileSystem.chmod(destination, file.source.executable ? 0o755 : 0o644);
  }
}

function resolveInstallationPath(projectRoot: string, installationPath: string): string {
  const candidate = path.resolve(projectRoot, ...installationPath.split("/"));
  const relative = path.relative(projectRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectInstallationError("unsafe-target", `Tracked Skill installation escapes the project root: ${installationPath}`);
  }
  return candidate;
}

function relativeSegments(root: string, candidate: string): readonly string[] {
  const relative = path.relative(root, candidate);
  return relative === "" ? [] : relative.split(path.sep);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes("\\") || path.posix.isAbsolute(candidate)) {
    return false;
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized !== candidate || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return false;
  }
  return normalized.split("/").every(isSafeSegment);
}

function isPortableV1Tree(files: readonly ValidatedTreeFile[]): boolean {
  return files.every((file) => !portableV1ExcludedDirectory(file.relativePath));
}

function portableV1ExcludedDirectory(relativePath: string): boolean {
  const excludedTopLevelDirectories = new Set([".claude", ".codex", ".opencode", ".pi", "extensions", "plugins", "mcp"]);
  const firstSegment = relativePath.split("/", 1)[0];
  return excludedTopLevelDirectories.has(firstSegment ?? "");
}

function isSafeSegment(candidate: string): boolean {
  if (candidate.length === 0 || candidate === "." || candidate === ".." || candidate.includes("/") || candidate.includes("\\")) {
    return false;
  }
  // Reject the Windows-invalid subset on every host so a portable Skill cannot
  // succeed on one host and become un-installable on another.
  if (Array.from(candidate).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  }) || /[<>:"|?*]/u.test(candidate) || /[. ]$/u.test(candidate)) {
    return false;
  }
  const deviceName = candidate.split(".", 1)[0].toLowerCase();
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(deviceName);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
