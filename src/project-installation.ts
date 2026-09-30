import { chmod, lstat, mkdir, readFile, readlink, readdir, rename, rmdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import path from "node:path";

import type { ProjectHost, ProjectSkillSelection } from "./project-manifest.js";
import { compareSkillTrees, readExistingSkillTree } from "./skill-adoption.js";
import type { SkillTreeComparisonReason, SkillTreeFileSystem } from "./skill-adoption.js";
import { pathsOverlap } from "./path-safety.js";
import { parseSkillFrontmatter, skillTreeBaseline } from "./skill-discovery.js";
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
  /** Removes exactly one non-directory entry (a symlink); never recursive. Defaults to the Node implementation. */
  unlink?(candidate: string): Promise<void>;
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
  /**
   * Where tracked installation paths come from. Project manifests are
   * repository-controlled (default); the user-global state file is written only
   * by Agent Depot and is trusted.
   */
  readonly installationTrust?: "project-manifest" | "user-global-state";
  /** Relative installation paths of the other tracked installations in this scope. */
  readonly otherInstallationPaths?: readonly string[];
  /** Absolute non-canonical path the user explicitly confirmed for this mutation. */
  readonly confirmedNonCanonicalPath?: string;
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
  /** Set when the tracked path is outside the canonical layout and needs explicit confirmation. */
  readonly nonCanonicalPath?: string;
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
  /** Set when the tracked path is outside the canonical layout and needs explicit confirmation. */
  readonly nonCanonicalPath?: string;
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
  const nonCanonicalPath = await classifyTrackedInstallation(projectRoot, selection.installation.path, skillName, options, fileSystem);

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
    ...(nonCanonicalPath === undefined ? {} : { nonCanonicalPath }),
  });
}

/**
 * Removes a previously inspected user-global Skill after rechecking ownership.
 * `deletePaths` narrows the deletion to a subset of the inspected paths (used
 * when only some Hosts are removed); the whole inspection is still rechecked.
 */
export async function removeProjectSkill(
  selection: ProjectSkillSelection,
  inspection: ProjectSkillRemovalInspection,
  options: ProjectInstallationOptions,
  deletePaths?: readonly string[],
): Promise<void> {
  assertNoOverlappingProjectSkillRemovalTargets([inspection]);
  const current = await inspectProjectSkillRemoval(selection, options);
  if (current.skillName !== inspection.skillName ||
    current.paths.length !== inspection.paths.length ||
    current.paths.some((candidate, index) => candidate !== inspection.paths[index]) ||
    current.digest !== inspection.digest ||
    current.adopted !== inspection.adopted ||
    current.modified !== inspection.modified ||
    current.nonCanonicalPath !== inspection.nonCanonicalPath) {
    throw new ProjectInstallationError("removal-changed", "The inspected Skill removal target, digest, adoption, or modification state changed; no path was removed");
  }
  assertNonCanonicalConfirmed(current.nonCanonicalPath, options);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const selected = deletePaths ?? current.paths;
  if (selected.some((candidate) => !current.paths.includes(candidate))) {
    throw new ProjectInstallationError("removal-changed", "A path selected for removal is not part of the inspected Skill installation; no path was removed");
  }
  for (const candidate of [...current.paths].reverse().filter((candidate) => selected.includes(candidate))) {
    if (deletePaths === undefined) {
      await fileSystem.rm(candidate);
    } else {
      await unlinkManagedSymlink(candidate, fileSystem);
    }
  }
}

/**
 * Deletes one managed symlink without ever following or recursing into it:
 * look at the path immediately before, require a symlink, then unlink it.
 * Partial Host removal only ever deletes the Claude symlink, so it uses this
 * instead of the recursive `rm` that full removal needs for the canonical directory.
 */
async function unlinkManagedSymlink(candidate: string, fileSystem: ProjectInstallationFileSystem): Promise<void> {
  const information = await fileSystem.lstat(candidate);
  if (!information.isSymbolicLink()) {
    throw new ProjectInstallationError(
      "unsafe-target",
      `Refusing to delete ${JSON.stringify(candidate)} because it is no longer a symlink; no path was changed`,
    );
  }
  await (fileSystem.unlink ?? unlink)(candidate);
}

/** Read-only receipt for exposing an installed user-global Skill to more Hosts. */
export interface ProjectSkillHostAdditionInspection {
  readonly skillName: string;
  readonly canonicalPath: string;
  readonly claudePath: string;
  /** Content digest of the installed Skill; must match before anything is created. */
  readonly digest: string;
  /** Host locations the addition creates; empty when every requested Host already resolves to an existing location. */
  readonly createPaths: readonly string[];
}

/**
 * Inspects what exposing the installed Skill to `hosts` would change without
 * writing. Non-Claude Hosts share the canonical `.agents/skills` location, and
 * Claude is a symlink to it; anything else at a target location is a conflict.
 */
export async function inspectProjectSkillHostAddition(
  selection: ProjectSkillSelection,
  hosts: readonly ProjectHost[],
  options: ProjectInstallationOptions,
): Promise<ProjectSkillHostAdditionInspection> {
  const removal = await inspectProjectSkillRemoval(selection, options);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const projectRoot = path.resolve(options.projectRoot);
  const canonicalPath = path.join(projectRoot, ".agents", "skills", removal.skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", removal.skillName);
  const installedAt = resolveInstallationPath(projectRoot, selection.installation!.path);
  if (installedAt !== canonicalPath) {
    throw new ProjectInstallationError(
      "host-exposure-unavailable",
      `Cannot expose ${JSON.stringify(removal.skillName)} to more Hosts because it is installed at ${JSON.stringify(installedAt)}, not the canonical ${JSON.stringify(canonicalPath)}; exposing it would require copying or moving it. No path was changed.`,
    );
  }
  const createPaths: string[] = [];
  if (hosts.includes("claude")) {
    await assertNoSymlinkAncestors(projectRoot, [".claude", "skills"], fileSystem);
    const existing = await fileSystem.lstat(claudePath).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (existing === undefined) {
      createPaths.push(claudePath);
    } else {
      const target = existing.isSymbolicLink() ? await fileSystem.readlink(claudePath) : undefined;
      if (target === undefined || path.resolve(path.dirname(claudePath), target) !== canonicalPath) {
        throw new ProjectInstallationError(
          "target-conflict",
          `Cannot expose ${JSON.stringify(removal.skillName)} to Claude because ${JSON.stringify(claudePath)} already exists and is not the managed symlink to the installed Skill; no path was changed.`,
        );
      }
    }
  }
  return Object.freeze({ skillName: removal.skillName, canonicalPath, claudePath, digest: removal.digest, createPaths: Object.freeze(createPaths) });
}

/**
 * Creates the Host locations of an inspected addition after rechecking that
 * nothing changed. The returned rollback removes only what this call created.
 */
export async function addProjectSkillHosts(
  selection: ProjectSkillSelection,
  hosts: readonly ProjectHost[],
  inspection: ProjectSkillHostAdditionInspection,
  options: ProjectInstallationOptions,
): Promise<{ rollback(): Promise<void> }> {
  const current = await inspectProjectSkillHostAddition(selection, hosts, options);
  if (current.digest !== inspection.digest || current.createPaths.length !== inspection.createPaths.length ||
    current.createPaths.some((candidate, index) => candidate !== inspection.createPaths[index])) {
    throw new ProjectInstallationError("host-addition-changed", "The inspected Skill installation or Host locations changed; no path was created");
  }
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const createdPaths: CreatedPath[] = [];
  const uncertainCreates = new Set<string>();
  try {
    if (current.createPaths.includes(current.claudePath)) {
      await createAdditionalClaudeExposure(path.resolve(options.projectRoot), current.canonicalPath, current.claudePath, fileSystem, createdPaths, uncertainCreates);
    }
  } catch (error) {
    const cleanupErrors = await rollbackCreatedPaths(createdPaths, uncertainCreates, fileSystem);
    if (cleanupErrors.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      throw new ProjectInstallationError("rollback-failed", `${original} Rollback was incomplete: ${cleanupErrors.join("; ")}`);
    }
    throw error;
  }
  return { rollback: createCreatedPathsRollback(createdPaths, uncertainCreates, fileSystem) };
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
  const nonCanonicalPath = await classifyTrackedInstallation(
    projectRoot, selection.installation.path, skillNameFromSelection(selection), options, fileSystem);
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
    ...(nonCanonicalPath === undefined ? {} : { nonCanonicalPath }),
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
  assertNonCanonicalConfirmed(
    await classifyTrackedInstallation(projectRoot, request.selection.installation.path, skillName, options, fileSystem),
    options,
  );
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
      await removeVerifiedReplacement(targetPath, replacementIdentity, fileSystem, errors);
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
  unlink,
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

  const locations: ProjectSkillInstallationLocationInspection[] = [];
  const expectedTree = files.map((file) => file.source);
  const treeAccess = { lstat: fileSystem.lstat, readdir: fileSystem.readdir, readFile: fileSystem.readFile };
  for (const candidate of [canonicalPath, claudePath]) {
    const canonicalIdentical = locations.some((location) => location.path === canonicalPath && location.status === "identical");
    locations.push(await inspectSkillLocation(candidate, {
      canonicalPath,
      claudePath,
      canonicalIdentical,
      selectionPath: request.selection.path,
      expectedTree,
      fileSystem,
      treeAccess,
    }));
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

interface SkillLocationContext {
  readonly canonicalPath: string;
  readonly claudePath: string;
  readonly canonicalIdentical: boolean;
  readonly selectionPath: string;
  readonly expectedTree: readonly SkillTreeFile[];
  readonly fileSystem: ProjectInstallationFileSystem;
  readonly treeAccess: SkillTreeFileSystem;
}

function collisionLocation(
  candidate: string,
  reason: ProjectSkillInstallationCollisionReason,
  evidence: { readonly identity?: string; readonly digest?: string } = {},
): ProjectSkillInstallationLocationInspection {
  const collision = Object.freeze({ path: candidate, reason });
  return Object.freeze({ path: candidate, status: "collision", collision, ...evidence });
}

async function inspectSkillLocation(
  candidate: string,
  context: SkillLocationContext,
): Promise<ProjectSkillInstallationLocationInspection> {
  const { fileSystem } = context;
  let information: Stats;
  try {
    information = await fileSystem.lstat(candidate);
  } catch (error) {
    if (isMissing(error)) return Object.freeze({ path: candidate, status: "missing" });
    throw error;
  }
  if (information.isSymbolicLink()) {
    return await isClaudeExposureOfCanonical(candidate, context)
      ? Object.freeze({ path: candidate, status: "identical" })
      : collisionLocation(candidate, "symbolic-link");
  }
  if (!information.isDirectory()) {
    return collisionLocation(candidate, "not-directory", { identity: pathIdentityKey(pathIdentity(information)) });
  }

  let actualTree: readonly SkillTreeFile[];
  try {
    actualTree = await readExistingSkillTree(candidate, context.selectionPath, context.treeAccess);
  } catch {
    return collisionLocation(candidate, "unsafe-file");
  }
  const comparison = compareSkillTrees(context.expectedTree, actualTree);
  const evidence = {
    identity: pathIdentityKey(pathIdentity(information)),
    digest: skillTreeBaseline(actualTree).digest,
  };
  return comparison.identical
    ? Object.freeze({ path: candidate, status: "identical", ...evidence })
    : collisionLocation(candidate, comparison.reason ?? "content-mismatch", evidence);
}

/** A Claude symlink is an exposure only when it points to the canonical Skill that was itself found identical. */
async function isClaudeExposureOfCanonical(candidate: string, context: SkillLocationContext): Promise<boolean> {
  if (candidate !== context.claudePath || !context.canonicalIdentical) return false;
  try {
    const target = await context.fileSystem.readlink(candidate);
    return path.resolve(path.dirname(candidate), target) === context.canonicalPath;
  } catch {
    return false;
  }
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
 * Explicit host evidence can reject before reading source bytes. The portable
 * baseline is different: its evidence is the validated tree itself, never a
 * caller's assertion alone.
 */
function validateEarlyCompatibility(request: ProjectSkillInstallationRequest, skillName: string): ReturnType<typeof validateCompatibility> | undefined {
  const hasDeclaredIncompatibility = Object.values(request.compatibility ?? {}).some((value) => value === false || typeof value === "string");
  const hasUnsupportedSelectedHost = request.compatibleHosts !== undefined &&
    request.selection.hosts.some((host) => !request.compatibleHosts?.includes(host));
  if (hasUnsupportedSelectedHost || hasDeclaredIncompatibility || request.portableV1 !== true) {
    return validateCompatibility(request, skillName, undefined);
  }
  return undefined;
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
  const earlyHosts = validateEarlyCompatibility(request, skillName);
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
      return overwriteProjectSkillTransaction(request, options, files, hosts, inspection);
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
        result: buildInstallationResult({
          request, skillName, canonicalPath: adoption.canonicalPath, claudePath, hosts, files, baseline,
          adoptedPaths: adoption.paths,
        }),
        rollback: createCreatedPathsRollback(createdPaths, uncertainCreates, fileSystem),
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
      await writeInstalledFile(canonicalPath, file, createdPaths, uncertainCreates, fileSystem);
    }
    if (hosts.includes("claude")) {
      await createClaudeSkillSymlink(claudePath, canonicalPath, createdPaths, uncertainCreates, fileSystem);
    }

    return Object.freeze({
      result: buildInstallationResult({ request, skillName, canonicalPath, claudePath, hosts, files, baseline, adoptedPaths: undefined }),
      rollback: createCreatedPathsRollback(createdPaths, uncertainCreates, fileSystem),
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

interface InstallationResultParts {
  readonly request: ProjectSkillInstallationRequest;
  readonly skillName: string;
  readonly canonicalPath: string;
  readonly claudePath: string;
  readonly hosts: readonly ProjectHost[];
  readonly files: readonly { readonly relativePath: string }[];
  readonly baseline: ProjectSkillInstallationResult["baseline"];
  /** Present only when an existing identical installation was adopted. */
  readonly adoptedPaths: readonly string[] | undefined;
}

function buildInstallationResult(parts: InstallationResultParts): ProjectSkillInstallationResult {
  const { request, skillName, canonicalPath, claudePath, hosts, files, baseline, adoptedPaths } = parts;
  return Object.freeze({
    skillName,
    canonicalPath,
    ...(hosts.includes("claude") ? { claudePath } : {}),
    hosts: Object.freeze([...hosts]),
    files: Object.freeze(files.map((file) => file.relativePath)),
    adopted: adoptedPaths !== undefined,
    adoptedPaths: Object.freeze([...(adoptedPaths ?? [])]),
    baseline,
    ...(request.resolvedVersion === undefined ? {} : { resolvedVersion: request.resolvedVersion }),
  });
}

function createCreatedPathsRollback(
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
  fileSystem: ProjectInstallationFileSystem,
): () => Promise<void> {
  return async () => {
    const cleanupErrors = await rollbackCreatedPaths(createdPaths, uncertainCreates, fileSystem);
    if (cleanupErrors.length > 0) {
      throw new ProjectInstallationError(
        "rollback-failed",
        `Rollback was incomplete: ${cleanupErrors.join("; ")}`,
      );
    }
  };
}

async function writeInstalledFile(
  canonicalPath: string,
  file: ValidatedTreeFile,
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
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

async function createClaudeSkillSymlink(
  claudePath: string,
  canonicalPath: string,
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
  fileSystem: ProjectInstallationFileSystem,
): Promise<void> {
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

interface OverwriteRollbackContext {
  readonly request: ProjectSkillInstallationRequest;
  readonly files: readonly ValidatedTreeFile[];
  readonly inspection: ProjectSkillInstallationInspection;
  readonly targetPath: string;
  readonly stagePath: string;
  readonly backupPath: string;
  readonly fileSystem: ProjectInstallationFileSystem;
}

interface OverwriteProgress {
  stageCreated: boolean;
  moved: boolean;
  replacementInstalled: boolean;
  replacementIdentity: PathIdentity | undefined;
  readonly exposureCreated: CreatedPath[];
  readonly exposureUncertain: Set<string>;
}

async function collectError(errors: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(errorMessage(error));
  }
}

async function restoreOverwrite(context: OverwriteRollbackContext, progress: OverwriteProgress): Promise<string[]> {
  const { stagePath, fileSystem } = context;
  const errors: string[] = [];
  errors.push(...await rollbackCreatedPaths(progress.exposureCreated, progress.exposureUncertain, fileSystem));
  if (progress.stageCreated) {
    await fileSystem.rm(stagePath).catch((error: unknown) => errors.push(`could not remove staging tree: ${errorMessage(error)}`));
  }
  if (progress.moved) {
    await restoreMovedOriginal(context, progress, errors);
  }
  return errors;
}

async function restoreMovedOriginal(
  context: OverwriteRollbackContext,
  progress: OverwriteProgress,
  errors: string[],
): Promise<void> {
  const { request, files, inspection, targetPath, backupPath, fileSystem } = context;
  const { replacementIdentity } = progress;
  if (replacementIdentity !== undefined) {
    await collectError(errors, () => assertReplacementMatchesPreview(targetPath, request, files, replacementIdentity, fileSystem));
  } else if (progress.replacementInstalled) {
    errors.push(`preserved replacement at ${JSON.stringify(targetPath)} because its identity could not be verified`);
  }
  if (errors.length === 0 && replacementIdentity !== undefined) {
    await collectError(errors, () => assertBackupMatchesInspection(backupPath, request, targetLocation(inspection), fileSystem));
  }
  if (errors.length === 0 && replacementIdentity !== undefined) {
    await removeVerifiedReplacement(targetPath, replacementIdentity, fileSystem, errors);
  }
  if (errors.length === 0) {
    await fileSystem.rename!(backupPath, targetPath).catch((error: unknown) => {
      errors.push(`could not restore original Skill: ${errorMessage(error)}`);
    });
  }
}

/**
 * Recheck ownership immediately before the destructive remove. Portable
 * filesystem APIs do not provide a cross-process compare-and-swap, so a
 * writer can still race after this check; any observed identity/content
 * drift is nevertheless preserved and fails closed.
 */
async function removeVerifiedReplacement(
  targetPath: string,
  replacementIdentity: PathIdentity | undefined,
  fileSystem: ProjectInstallationFileSystem,
  errors: string[],
): Promise<void> {
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

  const progress: OverwriteProgress = {
    stageCreated: false,
    moved: false,
    replacementInstalled: false,
    replacementIdentity: undefined,
    exposureCreated: [],
    exposureUncertain: new Set<string>(),
  };
  const { exposureCreated, exposureUncertain } = progress;
  const restore = (): Promise<string[]> => restoreOverwrite(
    { request, files, inspection, targetPath, stagePath, backupPath, fileSystem },
    progress,
  );

  try {
    await fileSystem.mkdir(stagePath);
    progress.stageCreated = true;
    await writeStagedTree(stagePath, files, fileSystem);
    // Revalidate after all potentially slow staging work and immediately before
    // moving the user's original tree. The preview bytes are immutable and no
    // external installation method has run at this point.
    await assertOverwriteInspectionUnchanged(request, options, inspection);
    await fileSystem.rename(targetPath, backupPath);
    progress.moved = true;
    // Rename preserves the original tree as a recovery boundary. Verify both
    // its native directory identity and its complete content receipt before the
    // staged tree is exposed at the installation path.
    await assertBackupMatchesInspection(backupPath, request, targetLocation(inspection), fileSystem);
    await fileSystem.rename(stagePath, targetPath);
    progress.stageCreated = false;
    progress.replacementInstalled = true;
    progress.replacementIdentity = pathIdentity(await fileSystem.lstat(targetPath));

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

function adoptionTreeAccess(fileSystem: ProjectInstallationFileSystem): SkillTreeFileSystem {
  const unavailable = (what: string): ProjectInstallationError => new ProjectInstallationError(
    "adoption-unavailable",
    `Cannot inspect an existing project Skill because ${what} reading is unavailable; retry with the standard filesystem adapter.`,
  );
  return {
    lstat: fileSystem.lstat,
    readdir: async (candidate) => {
      if (!fileSystem.readdir) throw unavailable("directory");
      return fileSystem.readdir(candidate);
    },
    readFile: async (candidate) => {
      if (!fileSystem.readFile) throw unavailable("file");
      return fileSystem.readFile(candidate);
    },
  };
}

async function assertExistingSkillMatches(
  candidate: string,
  sourceSkillPath: string,
  expectedTree: readonly SkillTreeFile[],
  treeAccess: SkillTreeFileSystem,
): Promise<void> {
  let actualTree: readonly SkillTreeFile[];
  try {
    actualTree = await readExistingSkillTree(candidate, sourceSkillPath, treeAccess);
  } catch (error) {
    throw new ProjectInstallationError(
      "unsafe-target",
      `Cannot safely inspect existing Skill at ${JSON.stringify(candidate)}: ${errorMessage(error)}. No path was changed.`,
    );
  }
  const comparison = compareSkillTrees(expectedTree, actualTree);
  if (!comparison.identical) {
    throw new ProjectInstallationError(
      "adoption-conflict",
      `Cannot adopt because an existing Skill already exists at ${JSON.stringify(candidate)} with different content (${comparison.reason}); explicit confirmation would be required to overwrite it, but this safe install flow has no overwrite operation. No path was changed.`,
    );
  }
}

async function createAdditionalClaudeExposure(
  projectRoot: string,
  canonicalPath: string,
  claudePath: string,
  fileSystem: ProjectInstallationFileSystem,
  createdPaths: CreatedPath[],
  uncertainCreates: Set<string>,
): Promise<void> {
  await ensureDirectoryTree(projectRoot, [".claude", "skills"], createdPaths, uncertainCreates, fileSystem);
  await assertMissing(claudePath, fileSystem, claudePath);
  uncertainCreates.add(claudePath);
  try {
    await fileSystem.symlink(path.relative(path.dirname(claudePath), canonicalPath), claudePath, "dir");
  } catch (error) {
    throw new ProjectInstallationError(
      "claude-symlink-failed",
      `Cannot create the additional Claude Skill symlink at ${JSON.stringify(claudePath)}: ${errorMessage(error)}. No existing path was changed.`,
    );
  }
  const information = await fileSystem.lstat(claudePath);
  if (!information.isSymbolicLink()) {
    throw new ProjectInstallationError("unsafe-target", `Claude installation path is not a symbolic link: ${claudePath}`);
  }
  createdPaths.push({ path: claudePath, kind: "symlink", identity: pathIdentity(information) });
  uncertainCreates.delete(claudePath);
}

function assertAdditionalExposureAllowed(
  existingPaths: readonly string[],
  canonicalPath: string,
  missingClaude: boolean,
  confirmed: boolean,
): void {
  if (!confirmed) {
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
  const canonicalPath = path.join(projectRoot, ".agents", "skills", skillName);
  const claudePath = path.join(projectRoot, ".claude", "skills", skillName);
  const existingPaths: string[] = [];
  const expectedTree = expectedFiles.map((file) => file.source);
  const treeAccess = adoptionTreeAccess(fileSystem);

  for (const candidate of [canonicalPath, claudePath]) {
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
    } else if (!information.isDirectory()) {
      throw new ProjectInstallationError(
        "adoption-conflict",
        `Cannot adopt because the existing Skill path ${JSON.stringify(candidate)} is not a directory; explicit confirmation would be required to overwrite it, but this safe install flow has no overwrite operation. No path was changed.`,
      );
    } else {
      await assertExistingSkillMatches(candidate, sourceSkillPath, expectedTree, treeAccess);
    }
    existingPaths.push(candidate);
  }

  if (existingPaths.length === 0) return undefined;

  const missingClaude = hosts.includes("claude") && !existingPaths.includes(claudePath);
  const missingCanonical = hosts.some((host) => host !== "claude") && !existingPaths.includes(canonicalPath);
  if (missingCanonical || missingClaude) {
    assertAdditionalExposureAllowed(existingPaths, canonicalPath, missingClaude, confirmAdditionalHostExposure);
    await createAdditionalClaudeExposure(projectRoot, canonicalPath, claudePath, fileSystem, createdPaths, uncertainCreates);
    existingPaths.push(claudePath);
  }

  return Object.freeze({
    canonicalPath: existingPaths.includes(canonicalPath) ? canonicalPath : claudePath,
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
  readonly directory: boolean;
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
    directory: information.isDirectory(),
  };
}

function hasNativeIdentity(identity: PathIdentity): boolean {
  return Number.isFinite(identity.device) && Number.isFinite(identity.inode) &&
    (identity.device !== 0 || identity.inode !== 0);
}

/**
 * Filesystems such as ext4 reuse a freed inode immediately, so a replacement
 * file can share dev/ino with the one we created. For non-directories the
 * native identity is therefore paired with `size` and a non-zero `birthtimeMs`:
 * both stay fixed between creation and rollback (chmod changes neither, and
 * identity is recorded before it), while a replacement almost always changes
 * at least one. `mode` and `ctime` are deliberately excluded because chmod and
 * rename legitimately change them.
 */
function nativeFileSuffix(identity: PathIdentity): string {
  if (identity.directory) return "";
  const birth = Number.isFinite(identity.birthtimeMs) && identity.birthtimeMs > 0 ? identity.birthtimeMs : 0;
  return `:${identity.size}:${birth}`;
}

function pathIdentityKey(identity: PathIdentity): string {
  // Rename may update ctime while preserving the native directory identity.
  // Use dev/inode when the platform provides them; only the fallback needs the
  // additional metadata because it has no native identity to compare.
  if (hasNativeIdentity(identity)) {
    return `native:${identity.device}:${identity.inode}${nativeFileSuffix(identity)}`;
  }
  return `fallback:${identity.birthtimeMs}:${identity.size}:${identity.mode}`;
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  // Prefer native device/inode identity. The birth/ctime fallback supports
  // hosts where the native values are unavailable while still failing closed
  // when no stable identity can be established.
  if (hasNativeIdentity(left)) {
    return pathIdentityKey(left) === pathIdentityKey(right);
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

const MANAGED_SKILL_ROOTS: ReadonlySet<string> = new Set([".agents", ".claude"]);

function resolveInstallationPath(projectRoot: string, installationPath: string): string {
  const candidate = path.resolve(projectRoot, ...installationPath.split("/"));
  const relative = path.relative(projectRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectInstallationError("unsafe-target", `Tracked Skill installation escapes the project root: ${installationPath}`);
  }
  return candidate;
}

function isCanonicalInstallation(relative: string): boolean {
  const segments = relative.split(path.sep);
  return segments.length === 3 && MANAGED_SKILL_ROOTS.has(segments[0]!) && segments[1] === "skills" &&
    isSafeSegment(segments[2]!);
}

/**
 * A project manifest is repository-controlled input, so only the canonical
 * layout (<root>/.agents|.claude/skills/<name>) is trusted as a replace/delete
 * target. An adopted Skill elsewhere is accepted only after strict validation
 * and is reported so the caller can require explicit confirmation of that path.
 * User-global records come from Agent Depot's own state file and stay trusted.
 * Returns the absolute non-canonical path, or undefined for a trusted path.
 */
async function classifyTrackedInstallation(
  projectRoot: string,
  installationPath: string,
  skillName: string,
  options: ProjectInstallationOptions,
  fileSystem: ProjectInstallationFileSystem,
): Promise<string | undefined> {
  const targetPath = resolveInstallationPath(projectRoot, installationPath);
  const relative = path.relative(projectRoot, targetPath);
  if (options.installationTrust === "user-global-state" || isCanonicalInstallation(relative)) {
    return undefined;
  }
  const reject = (reason: string): never => {
    throw new ProjectInstallationError(
      "unsafe-target",
      `Tracked Skill installation ${JSON.stringify(installationPath)} is outside .agents/skills and .claude/skills and ${reason}; no path was changed`,
    );
  };
  const segments = relative.split(path.sep);
  if (!isSafeRelativePath(installationPath)) reject("is not a safe relative path");
  if (segments.some((segment) => segment.toLowerCase() === ".git")) reject("is inside .git");
  if (segments[segments.length - 1] !== skillName) reject(`does not end in the Skill name ${JSON.stringify(skillName)}`);
  for (const other of options.otherInstallationPaths ?? []) {
    const inside = path.relative(targetPath, path.resolve(projectRoot, ...other.split("/")));
    if (inside !== "" && inside !== ".." && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside)) {
      reject(`contains another tracked installation (${JSON.stringify(other)})`);
    }
  }
  let current = projectRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const information = await fileSystem.lstat(current).catch((error: unknown) => {
      if (isMissing(error)) {
        throw new ProjectInstallationError("missing-installation", `The tracked Skill installation does not exist: ${targetPath}; no path was changed`);
      }
      throw error;
    });
    if (information.isSymbolicLink() || !information.isDirectory()) reject(`has a component that is not a real directory: ${current}`);
  }
  if (!fileSystem.readFile) {
    throw new ProjectInstallationError("update-unavailable", "Validating a non-canonical Skill installation requires filesystem read support");
  }
  const skillFile = path.join(targetPath, "SKILL.md");
  const skillInformation = await fileSystem.lstat(skillFile).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  const declared = skillInformation?.isFile() === true
    ? parseSkillFrontmatter(Buffer.from(await fileSystem.readFile(skillFile)).toString("utf8"))?.name
    : undefined;
  if (declared !== skillName) reject(`does not contain a SKILL.md whose name is ${JSON.stringify(skillName)}`);
  return targetPath;
}

function assertNonCanonicalConfirmed(nonCanonicalPath: string | undefined, options: ProjectInstallationOptions): void {
  if (nonCanonicalPath !== undefined && options.confirmedNonCanonicalPath !== nonCanonicalPath) {
    throw new ProjectInstallationError(
      "non-canonical-confirmation-required",
      `The tracked Skill is installed at the non-canonical location ${JSON.stringify(nonCanonicalPath)}; explicit confirmation of that exact path is required and no path was changed`,
    );
  }
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
