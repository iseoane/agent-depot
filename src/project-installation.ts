import { chmod, lstat, mkdir, readFile, readlink, readdir, rmdir, rm, symlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { ProjectHost, ProjectSkillSelection } from "./project-manifest.js";
import { compareSkillTrees, readExistingSkillTree } from "./skill-adoption.js";
import type { SkillTreeFileSystem } from "./skill-adoption.js";
import type { SkillTreeFile } from "./skill-discovery.js";
import type { Source } from "./sources.js";

export interface ProjectSkillTreeAccess {
  readSkillTree(source: Source, skillPath: string): Promise<readonly SkillTreeFile[]>;
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
  /** Optional read methods used only when adopting an existing Skill. */
  readdir?(candidate: string): Promise<readonly string[]>;
  readFile?(candidate: string): Promise<Uint8Array>;
}

export interface ProjectSkillInstallationRequest {
  readonly selection: ProjectSkillSelection;
  /** The resolved Source used by the full Skill tree reader. */
  readonly source: Source;
  /**
   * The immutable tree shown in the caller's preview. When supplied, the
   * installer never reads the Source again, so installation cannot drift from
   * the bytes the user confirmed.
   */
  readonly previewTree?: readonly SkillTreeFile[];
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
}

export interface ProjectInstallationOptions {
  readonly projectRoot: string;
  readonly sourceAccess: ProjectSkillTreeAccess;
  readonly fileSystem?: ProjectInstallationFileSystem;
}

export interface ProjectSkillInstallationResult {
  readonly skillName: string;
  readonly canonicalPath: string;
  readonly claudePath?: string;
  readonly hosts: readonly ProjectHost[];
  readonly files: readonly string[];
  /** True when the existing project tree was adopted without writing it. */
  readonly adopted: boolean;
  /** Existing known project locations retained by an adoption. */
  readonly adoptedPaths: readonly string[];
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
  readlink,
  rm: async (candidate) => {
    await rm(candidate, { recursive: true, force: true });
  },
  rmdir,
};

/**
 * Installs one selected Skill into a project without consulting user-global
 * state, adopting existing paths, or overwriting any existing path.
 */
export async function installProjectSkill(
  request: ProjectSkillInstallationRequest,
  options: ProjectInstallationOptions,
): Promise<ProjectSkillInstallationResult> {
  const transaction = await installProjectSkillTransaction(request, options);
  return transaction.result;
}

/**
 * Installs one Skill and retains the created-path receipt for a surrounding
 * manifest/batch transaction. Existing paths are never included in the
 * receipt and are therefore never removed by rollback.
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
  const hosts = earlyHosts ?? validateCompatibility(request, skillName, files);

  const canonicalSkillsPath = path.join(projectRoot, ".agents", "skills");
  const canonicalPath = path.join(canonicalSkillsPath, skillName);
  const claudeSkillsPath = path.join(projectRoot, ".claude", "skills");
  const claudePath = path.join(claudeSkillsPath, skillName);
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
  const excludedTopLevelDirectories = new Set([".claude", ".codex", ".opencode", ".pi", "agents", "extensions", "plugins", "mcp"]);
  return files.every((file) => {
    const firstSegment = file.relativePath.split("/", 1)[0];
    return !excludedTopLevelDirectories.has(firstSegment ?? "");
  });
}

function isSafeSegment(candidate: string): boolean {
  if (candidate.length === 0 || candidate === "." || candidate === ".." || candidate.includes("/") || candidate.includes("\\")) {
    return false;
  }
  // Reject the Windows-invalid subset on every host so a portable Skill cannot
  // succeed on one host and become un-installable on another.
  if (/[\u0000-\u001f\u007f<>:"|?*]/u.test(candidate) || /[. ]$/u.test(candidate)) {
    return false;
  }
  const deviceName = candidate.split(".", 1)[0].toLowerCase();
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(deviceName);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
