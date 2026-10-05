import { lstat, readdir, readFile, readlink, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { assertSkillNotAppOwned, loadAppOwnedSkillFilter, type AppOwnedSkillOptions } from "./app-owned-skills.js";
import {
  assertSkillNotPackageOwned,
  loadPackageOwnedSkillFilter,
  type PackageOwnedSkillOptions,
} from "./package-owned-skills.js";
import { pathsOverlap } from "./path-safety.js";
import { readExistingSkillTree } from "./skill-adoption.js";
import { parseSkillFrontmatter, skillTreeBaseline } from "./skill-discovery.js";
import type { ProjectSkillSelection } from "./project-manifest.js";

const GLOBAL_SKILL_ROOTS = [
  { kind: "agents" as const, relativePath: [".agents", "skills"] as const },
  { kind: "claude" as const, relativePath: [".claude", "skills"] as const },
];

type GlobalSkillRootKind = (typeof GLOBAL_SKILL_ROOTS)[number]["kind"];

export interface UserGlobalSkillFileSystem {
  readonly lstat: (candidatePath: string) => Promise<Stats>;
  readonly readdir: (candidatePath: string) => Promise<readonly string[]>;
  readonly readFile: (candidatePath: string) => Promise<Uint8Array>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly rm: (candidatePath: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
}

const nodeFileSystem: UserGlobalSkillFileSystem = {
  lstat,
  readdir: async (candidatePath) => readdir(candidatePath),
  readFile,
  rename,
  rm,
};

/** A validated, immediate child Skill directory found in a supported global root. */
export interface UserGlobalSkillInventoryEntry {
  readonly name: string;
  /** Absolute path to the discovered directory. */
  readonly path: string;
  /** The supported global root in which the entry was found. */
  readonly root: GlobalSkillRootKind;
  /** The shared Host family represented by the root. */
  readonly host: "shared" | "claude";
  readonly status: "managed" | "unmanaged";
}

export type UserGlobalSkillSkipReason =
  | "unsafe-root"
  | "unsafe-entry"
  | "unsafe-skill-file"
  | "excluded-transient";

/** An entry that was deliberately not made eligible for later removal. */
export interface UserGlobalSkillInventorySkippedEntry {
  readonly name?: string;
  readonly path: string;
  readonly root: GlobalSkillRootKind;
  readonly reason: UserGlobalSkillSkipReason;
  readonly detail?: string;
}

/** A host-root symlink that Agent Depot recognises as exposing a listed canonical Skill. */
export interface UserGlobalSkillExposure {
  readonly name: string;
  readonly path: string;
  readonly root: GlobalSkillRootKind;
  /** The canonical directory the symlink resolves to. */
  readonly target: string;
}

/**
 * A symlink entry in a supported root that Agent Depot does not recognise as its own
 * exposure (for example a link to a local development repository). Informational:
 * it is never an `unmanaged` removal candidate of the directory-removal path.
 */
export interface UserGlobalSkillInventorySymlink {
  readonly name: string;
  readonly path: string;
  readonly root: GlobalSkillRootKind;
  /** Where the link points, resolved against the link's directory. */
  readonly target: string;
}

export interface UserGlobalSkillInventory {
  readonly homeDirectory: string;
  readonly entries: readonly UserGlobalSkillInventoryEntry[];
  readonly managed: readonly UserGlobalSkillInventoryEntry[];
  readonly unmanaged: readonly UserGlobalSkillInventoryEntry[];
  readonly skipped: readonly UserGlobalSkillInventorySkippedEntry[];
  /** Same-name host symlinks to a listed canonical Skill; informational, never removal candidates. */
  readonly exposures: readonly UserGlobalSkillExposure[];
  /** Other symlinks under the roots; they are also reported in `skipped` and are never `unmanaged` entries. */
  readonly symlinks: readonly UserGlobalSkillInventorySymlink[];
}

export interface UserGlobalSkillInventoryOptions extends AppOwnedSkillOptions, PackageOwnedSkillOptions {
  /** Home directory to inspect; defaults to the current user's home directory. */
  readonly homeDirectory?: string;
  /** Validated user-global selections loaded from Source state. */
  readonly managedInstallations?: readonly ProjectSkillSelection[];
  /** Alias for callers that use the catalog's selection vocabulary. */
  readonly managedSelections?: readonly ProjectSkillSelection[];
}

/**
 * Scans only the immediate real directories below the two supported global Skill
 * roots. This operation never reads a Skill tree or changes the filesystem.
 *
 * A persisted installation location is the ownership identity. Its normalized
 * absolute path is compared directly, which preserves noncanonical adopted
 * locations instead of guessing ownership from a Skill name alone.
 */
export async function scanUserGlobalSkillInventory(
  options: UserGlobalSkillInventoryOptions = {},
): Promise<UserGlobalSkillInventory> {
  const homeDirectory = path.resolve(options.homeDirectory ?? homedir());
  const selections = options.managedInstallations ?? options.managedSelections ?? [];
  const managedPaths = new Set<string>();
  const managedCanonicalPaths = new Set<string>();

  for (const selection of selections) {
    const installationPath = selection.installation?.path;
    if (installationPath === undefined) continue;
    const absolutePath = resolveInstallationPath(homeDirectory, installationPath);
    if (absolutePath === undefined) continue;
    managedPaths.add(pathKey(absolutePath));

    // Only a persisted canonical location is authoritative for deduplicating
    // an exposure symlink. A Claude-only adopted directory is deliberately not
    // treated as ownership of a same-name canonical directory: that separate
    // real directory must remain visible as a possible duplicate.
    if (isUnderGlobalRoot(absolutePath, homeDirectory, ".agents")) {
      managedCanonicalPaths.add(pathKey(absolutePath));
    }
  }

  const entries: UserGlobalSkillInventoryEntry[] = [];
  const skipped: UserGlobalSkillInventorySkippedEntry[] = [];
  const exposures: UserGlobalSkillExposure[] = [];
  const symlinks: UserGlobalSkillInventorySymlink[] = [];
  const isAppOwned = await loadAppOwnedSkillFilter({ ...options, homeDirectory });
  const owned = await loadPackageOwnedSkillFilter({ ...options, homeDirectory });
  const isPackageOwned = (name: string): boolean => owned(name) !== undefined;
  const state: ScanState = { isAppOwned, isPackageOwned, managedPaths, managedCanonicalPaths, entries, skipped, exposures, symlinks };
  for (const root of GLOBAL_SKILL_ROOTS) {
    const rootPath = path.join(homeDirectory, ...root.relativePath);
    await scanRoot(root, rootPath, homeDirectory, state);
  }

  const managed = entries.filter((entry) => entry.status === "managed");
  const unmanaged = entries.filter((entry) => entry.status === "unmanaged");
  return Object.freeze({
    homeDirectory,
    entries: Object.freeze(entries),
    managed: Object.freeze(managed),
    unmanaged: Object.freeze(unmanaged),
    skipped: Object.freeze(skipped),
    exposures: Object.freeze(exposures),
    symlinks: Object.freeze(symlinks),
  });
}

/** Short alias for callers that only need the inventory operation. */
export const scanUserGlobalSkills = scanUserGlobalSkillInventory;

interface ScanState {
  readonly isAppOwned: (name: string) => boolean;
  readonly isPackageOwned: (name: string) => boolean;
  readonly managedPaths: ReadonlySet<string>;
  readonly managedCanonicalPaths: ReadonlySet<string>;
  readonly entries: UserGlobalSkillInventoryEntry[];
  readonly skipped: UserGlobalSkillInventorySkippedEntry[];
  readonly exposures: UserGlobalSkillExposure[];
  readonly symlinks: UserGlobalSkillInventorySymlink[];
}

type GlobalSkillRoot = (typeof GLOBAL_SKILL_ROOTS)[number];

async function scanRoot(
  root: GlobalSkillRoot,
  rootPath: string,
  homeDirectory: string,
  state: ScanState,
): Promise<void> {
  const names = await listScannableRoot(root, rootPath, homeDirectory, state.skipped);
  for (const name of names ?? []) {
    await scanRootEntry(root, name, path.join(rootPath, name), homeDirectory, state);
  }
}

/** Returns the sorted entry names of a safe root, or undefined when it is missing or reported as skipped. */
async function listScannableRoot(
  root: GlobalSkillRoot,
  rootPath: string,
  homeDirectory: string,
  skipped: UserGlobalSkillInventorySkippedEntry[],
): Promise<string[] | undefined> {
  const ancestorSafety = await inspectGlobalRootAncestors(homeDirectory, rootPath);
  if (ancestorSafety === "missing") return undefined;
  if (ancestorSafety !== undefined) {
    skipped.push(skip(rootPath, root.kind, "unsafe-root", ancestorSafety));
    return undefined;
  }
  let rootInformation: Stats;
  try {
    rootInformation = await lstat(rootPath);
  } catch (error) {
    if (!isMissing(error)) skipped.push(skip(rootPath, root.kind, "unsafe-root", errorMessage(error)));
    return undefined;
  }
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    skipped.push(skip(rootPath, root.kind, "unsafe-root", "global Skill root is not a real directory"));
    return undefined;
  }
  try {
    return (await readdir(rootPath)).sort();
  } catch (error) {
    skipped.push(skip(rootPath, root.kind, "unsafe-root", errorMessage(error)));
    return undefined;
  }
}

async function scanRootEntry(
  root: GlobalSkillRoot,
  name: string,
  candidatePath: string,
  homeDirectory: string,
  state: ScanState,
): Promise<void> {
  const { managedPaths, entries, skipped } = state;
  if (!managedPaths.has(pathKey(candidatePath)) && (state.isAppOwned(name) || state.isPackageOwned(name))) return;
  if (isTransientName(name)) {
    skipped.push({ name, path: candidatePath, root: root.kind, reason: "excluded-transient" });
    return;
  }

  let information: Stats;
  try {
    // lstat is deliberate: neither an entry nor any ancestor below the root
    // is followed while deciding whether it is eligible for removal.
    information = await lstat(candidatePath);
  } catch (error) {
    if (!isMissing(error)) skipped.push(skip(candidatePath, root.kind, "unsafe-entry", errorMessage(error), name));
    return;
  }

  if (information.isSymbolicLink()) {
    await classifySymlink(candidatePath, name, root.kind, homeDirectory, state);
    return;
  }
  if (!information.isDirectory()) return;

  const problem = await findSkillDirectoryProblem(candidatePath);
  if (problem === "not-a-skill") return;
  if (problem !== undefined) {
    skipped.push(skip(candidatePath, root.kind, problem.reason, problem.detail, name));
    return;
  }
  entries.push(Object.freeze<UserGlobalSkillInventoryEntry>({
    name,
    path: candidatePath,
    root: root.kind,
    host: root.kind === "claude" ? "claude" : "shared",
    status: managedPaths.has(pathKey(candidatePath)) ? "managed" : "unmanaged",
  }));
}

/** Why a real directory is not an eligible Skill: silently "not-a-skill" (no SKILL.md) or a reported problem. */
async function findSkillDirectoryProblem(
  candidatePath: string,
): Promise<{ readonly reason: "unsafe-skill-file" | "unsafe-entry"; readonly detail: string } | "not-a-skill" | undefined> {
  const skillFile = path.join(candidatePath, "SKILL.md");
  let skillFileInformation: Stats;
  try {
    skillFileInformation = await lstat(skillFile);
  } catch (error) {
    return isMissing(error) ? "not-a-skill" : { reason: "unsafe-skill-file", detail: errorMessage(error) };
  }
  if (skillFileInformation.isSymbolicLink() || !skillFileInformation.isFile()) {
    return { reason: "unsafe-skill-file", detail: "SKILL.md is not a real file" };
  }
  let skillContent: Uint8Array;
  try {
    skillContent = await readFile(skillFile);
  } catch (error) {
    return { reason: "unsafe-skill-file", detail: `SKILL.md cannot be read: ${errorMessage(error)}` };
  }
  if (parseSkillFrontmatter(Buffer.from(skillContent).toString("utf8")) === undefined) {
    return { reason: "unsafe-skill-file", detail: "SKILL.md does not contain valid top-level name and description frontmatter" };
  }
  const unsafeTreeEntry = await findUnsafeTreeEntry(candidatePath);
  return unsafeTreeEntry === undefined ? undefined : { reason: "unsafe-entry", detail: unsafeTreeEntry };
}

async function classifySymlink(
  candidatePath: string,
  name: string,
  root: GlobalSkillRootKind,
  homeDirectory: string,
  state: ScanState,
): Promise<void> {
  const { managedCanonicalPaths, managedPaths, entries, skipped, exposures, symlinks } = state;
  let linkTarget: string;
  try {
    linkTarget = await readlink(candidatePath);
  } catch (error) {
    skipped.push(skip(candidatePath, root, "unsafe-entry", errorMessage(error), name));
    return;
  }
  const resolvedTarget = path.resolve(path.dirname(candidatePath), linkTarget);
  // Only an exact same-name link to a direct child of the canonical root can be
  // an exposure created by Agent Depot; anything else stays reported.
  const isSameNameCanonical = root === "claude" &&
    isUnderGlobalRoot(resolvedTarget, homeDirectory, ".agents") &&
    path.basename(resolvedTarget) === name &&
    pathKey(path.dirname(resolvedTarget)) === pathKey(path.join(homeDirectory, ".agents", "skills"));
  const isManagedAlias = isSameNameCanonical &&
    (managedCanonicalPaths.has(pathKey(resolvedTarget)) || managedPaths.has(pathKey(candidatePath)));
  const isListedCanonical = isSameNameCanonical &&
    entries.some((entry) => entry.root === "agents" && pathKey(entry.path) === pathKey(resolvedTarget));

  if (isManagedAlias || isListedCanonical) {
    const targetSafety = await inspectCanonicalTarget(resolvedTarget);
    if (targetSafety === undefined) {
      exposures.push({ name, path: candidatePath, root, target: resolvedTarget });
      return;
    }
    skipped.push(skip(candidatePath, root, "unsafe-entry", targetSafety, name));
    return;
  }
  skipped.push(skip(candidatePath, root, "unsafe-entry", "symbolic-link entries are never removal candidates", name));
  if (!managedPaths.has(pathKey(candidatePath))) symlinks.push({ name, path: candidatePath, root, target: resolvedTarget });
}

async function findUnsafeTreeEntry(candidatePath: string, relativeDirectory = ""): Promise<string | undefined> {
  let names: readonly string[];
  try {
    names = await readdir(candidatePath);
  } catch (error) {
    return `Skill tree could not be inspected: ${errorMessage(error)}`;
  }
  for (const name of [...names].sort()) {
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    const childPath = path.join(candidatePath, name);
    let information: Stats;
    try {
      information = await lstat(childPath);
    } catch (error) {
      return `Skill tree entry ${relativePath} could not be inspected: ${errorMessage(error)}`;
    }
    if (information.isSymbolicLink()) return `Skill tree contains a symbolic link: ${relativePath}`;
    if (information.isDirectory()) {
      const nested = await findUnsafeTreeEntry(childPath, relativePath);
      if (nested !== undefined) return nested;
      continue;
    }
    if (!information.isFile()) return `Skill tree contains a non-regular file: ${relativePath}`;
  }
  return undefined;
}

async function inspectGlobalRootAncestors(homeDirectory: string, rootPath: string): Promise<string | "missing" | undefined> {
  const relative = path.relative(homeDirectory, rootPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return "global Skill root has an unsafe ancestor";
  }
  let current = homeDirectory;
  for (const segment of ["", ...relative.split(path.sep)]) {
    if (segment !== "") current = path.join(current, segment);
    let information: Stats;
    try {
      information = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return "missing";
      return errorMessage(error);
    }
    if (information.isSymbolicLink() || !information.isDirectory()) {
      return `global Skill root ancestor is not a real directory: ${current}`;
    }
  }
  return undefined;
}

async function inspectCanonicalTarget(candidatePath: string): Promise<string | undefined> {
  let targetInformation: Stats;
  try {
    targetInformation = await lstat(candidatePath);
  } catch (error) {
    return `managed canonical target is unavailable: ${errorMessage(error)}`;
  }
  if (targetInformation.isSymbolicLink() || !targetInformation.isDirectory()) {
    return "managed canonical target is not a real directory";
  }
  let skillInformation: Stats;
  try {
    skillInformation = await lstat(path.join(candidatePath, "SKILL.md"));
  } catch (error) {
    return `managed canonical Skill file is unavailable: ${errorMessage(error)}`;
  }
  if (skillInformation.isSymbolicLink() || !skillInformation.isFile()) {
    return "managed canonical target does not contain a real SKILL.md file";
  }
  return undefined;
}

export interface UserGlobalSkillRemovalInspection {
  readonly name: string;
  readonly path: string;
  readonly identity: string;
  readonly digest: string;
}

export interface UserGlobalSkillRemovalOptions extends AppOwnedSkillOptions, PackageOwnedSkillOptions {
  readonly homeDirectory: string;
  readonly managedInstallations: readonly ProjectSkillSelection[];
  readonly fileSystem?: UserGlobalSkillFileSystem;
  /** Optional final record read used to fail closed against cooperating state changes. */
  readonly readManagedInstallations?: () => Promise<readonly ProjectSkillSelection[]>;
  readonly expectedManagedInstallations?: readonly ProjectSkillSelection[];
}

/**
 * Inspects one explicit unmanaged global path without resolving or searching a
 * Source. The complete tree must be real-directory/regular-file content so a
 * later recursive delete cannot follow a link or special file.
 */
export async function inspectUserGlobalSkillRemoval(
  candidatePath: string,
  options: UserGlobalSkillRemovalOptions,
): Promise<UserGlobalSkillRemovalInspection> {
  const homeDirectory = path.resolve(options.homeDirectory);
  const targetPath = validateExplicitGlobalPath(candidatePath, homeDirectory);
  await assertSkillNotAppOwned(path.basename(candidatePath), options);
  assertSkillNotPackageOwned(path.basename(candidatePath), await loadPackageOwnedSkillFilter({ ...options, homeDirectory }));
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  await assertRealGlobalAncestors(homeDirectory, path.dirname(targetPath), fileSystem);
  const managedPaths = managedProtectionPaths(homeDirectory, options.managedInstallations);
  const managedPath = managedPaths.find((protectedPath) => pathsOverlap(pathKey(targetPath), pathKey(protectedPath)));
  if (managedPath !== undefined) {
    throw new Error(`Cannot remove ${JSON.stringify(targetPath)} because it is managed or aliases a managed installation at ${JSON.stringify(managedPath)}; no path was changed`);
  }

  const information = await realDirectory(targetPath, "selected unmanaged Skill", fileSystem);
  const skillFile = path.join(targetPath, "SKILL.md");
  const skillInformation = await fileSystem.lstat(skillFile);
  if (skillInformation.isSymbolicLink() || !skillInformation.isFile()) {
    throw new Error(`Selected unmanaged Skill must contain a real SKILL.md file: ${targetPath}; no path was changed`);
  }
  const skillContent = await fileSystem.readFile(skillFile);
  if (parseSkillFrontmatter(Buffer.from(skillContent).toString("utf8")) === undefined) {
    throw new Error(`Selected unmanaged Skill must contain valid top-level name and description frontmatter: ${targetPath}; no path was changed`);
  }
  const tree = await readUnmanagedTree(targetPath, path.basename(targetPath), fileSystem);
  return Object.freeze({
    name: path.basename(targetPath),
    path: targetPath,
    identity: fileIdentity(information),
    digest: skillTreeBaseline(tree).digest,
  });
}

/** Refuses selected unmanaged paths that overlap physically or through Host aliases. */
export function assertNoOverlappingUserGlobalSkillRemovals(
  inspections: readonly UserGlobalSkillRemovalInspection[],
): void {
  for (let leftIndex = 0; leftIndex < inspections.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inspections.length; rightIndex += 1) {
      const left = inspections[leftIndex]!;
      const right = inspections[rightIndex]!;
      const leftAliases = globalPathAliases(left.path);
      const rightAliases = globalPathAliases(right.path);
      if (leftAliases.some((candidate) => rightAliases.some((other) => pathsOverlap(pathKey(candidate), pathKey(other))))) {
        throw new Error(`Cannot remove selected unmanaged Skills because their paths or canonical/Claude aliases overlap: ${JSON.stringify(left.path)} and ${JSON.stringify(right.path)}; no path was changed`);
      }
    }
  }
}

/**
 * Rechecks an inspected unmanaged Skill, moves it to same-parent staging, and
 * permanently deletes only after validating the moved tree. A drifted or
 * unverifiable staged tree is retained rather than guessed at.
 */
export async function removeUserGlobalSkill(
  inspection: UserGlobalSkillRemovalInspection,
  options: UserGlobalSkillRemovalOptions,
): Promise<void> {
  const current = await inspectUserGlobalSkillRemoval(inspection.path, options);
  if (current.name !== inspection.name || current.path !== inspection.path || current.identity !== inspection.identity || current.digest !== inspection.digest) {
    throw new Error(`The inspected unmanaged Skill changed before deletion: ${JSON.stringify(inspection.path)}; no path was changed`);
  }
  let removalOptions = options;
  if (options.readManagedInstallations !== undefined) {
    const latestManagedInstallations = await options.readManagedInstallations();
    if (options.expectedManagedInstallations !== undefined && !sameManagedInstallations(options.expectedManagedInstallations, latestManagedInstallations)) {
      throw new Error(`Managed Skill records changed before deleting unmanaged Skill ${JSON.stringify(inspection.path)}; no path was changed`);
    }
    const latest = await inspectUserGlobalSkillRemoval(inspection.path, {
      ...options,
      managedInstallations: latestManagedInstallations,
    });
    if (latest.name !== inspection.name || latest.path !== inspection.path || latest.identity !== inspection.identity || latest.digest !== inspection.digest) {
      throw new Error(`The inspected unmanaged Skill changed before deletion: ${JSON.stringify(inspection.path)}; no path was changed`);
    }
    removalOptions = { ...options, managedInstallations: latestManagedInstallations };
  }

  const fileSystem = removalOptions.fileSystem ?? nodeFileSystem;
  const stagingPath = path.join(path.dirname(inspection.path), `.${inspection.name}.agent-depot-unmanaged-stage-${randomUUID()}`);
  try {
    await fileSystem.rename(inspection.path, stagingPath);
  } catch (error) {
    throw new Error(`Could not stage unmanaged Skill ${JSON.stringify(inspection.path)} before deletion: ${errorMessage(error)}; no path was changed`);
  }

  try {
    const staged = await inspectStagedSkill(stagingPath, inspection.name, fileSystem);
    if (staged.identity !== inspection.identity || staged.digest !== inspection.digest) {
      throw new Error("the staged tree's identity or content changed");
    }
    await fileSystem.rm(stagingPath, { recursive: true, force: false });
  } catch (error) {
    const restored = await restoreStagedSkill(stagingPath, inspection.path, inspection, fileSystem);
    if (restored) {
      throw new Error(`Unmanaged Skill deletion stopped for ${JSON.stringify(inspection.path)}; the original was restored and no permanent deletion occurred: ${errorMessage(error)}`);
    }
    throw new Error(`Unmanaged Skill deletion status is uncertain for ${JSON.stringify(inspection.path)}; staged path retained at ${JSON.stringify(stagingPath)} and recovery is not guaranteed: ${errorMessage(error)}`);
  }
}

export interface UserGlobalSymlinkRemovalInspection {
  readonly name: string;
  readonly path: string;
  /** The link text as read from disk. */
  readonly target: string;
  readonly identity: string;
}

/**
 * Inspects one explicit symlink below a supported global root. Only the link is
 * ever removed; the path it points to is never read, followed or changed.
 */
export async function inspectUserGlobalSymlinkRemoval(
  candidatePath: string,
  options: UserGlobalSkillRemovalOptions,
): Promise<UserGlobalSymlinkRemovalInspection> {
  const homeDirectory = path.resolve(options.homeDirectory);
  const linkPath = validateExplicitGlobalPath(candidatePath, homeDirectory);
  await assertSkillNotAppOwned(path.basename(candidatePath), options);
  assertSkillNotPackageOwned(path.basename(candidatePath), await loadPackageOwnedSkillFilter({ ...options, homeDirectory }));
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  await assertRealGlobalAncestors(homeDirectory, path.dirname(linkPath), fileSystem);
  const managedPath = managedProtectionPaths(homeDirectory, options.managedInstallations)
    .find((protectedPath) => pathsOverlap(pathKey(linkPath), protectedPath));
  if (managedPath !== undefined) {
    throw new Error(`Cannot remove ${JSON.stringify(linkPath)} because it is managed or aliases a managed installation at ${JSON.stringify(managedPath)}; no path was changed`);
  }
  const information = await fileSystem.lstat(linkPath);
  if (!information.isSymbolicLink()) {
    throw new Error(`Selected unmanaged link must be a symbolic link: ${linkPath}; no path was changed`);
  }
  return Object.freeze({
    name: path.basename(linkPath),
    path: linkPath,
    target: await readlink(linkPath),
    identity: fileIdentity(information),
  });
}

/** Rechecks the inspected link (and the managed records when given), then unlinks only the link. */
export async function removeUserGlobalSymlink(
  inspection: UserGlobalSymlinkRemovalInspection,
  options: UserGlobalSkillRemovalOptions,
): Promise<void> {
  const unchanged = (current: UserGlobalSymlinkRemovalInspection) =>
    current.name === inspection.name && current.path === inspection.path &&
    current.target === inspection.target && current.identity === inspection.identity;
  const changed = () => new Error(`The inspected unmanaged link changed before deletion: ${JSON.stringify(inspection.path)}; no path was changed`);
  if (!unchanged(await inspectUserGlobalSymlinkRemoval(inspection.path, options))) throw changed();
  if (options.readManagedInstallations !== undefined) {
    const latest = await options.readManagedInstallations();
    if (options.expectedManagedInstallations !== undefined && !sameManagedInstallations(options.expectedManagedInstallations, latest)) {
      throw new Error(`Managed Skill records changed before deleting unmanaged link ${JSON.stringify(inspection.path)}; no path was changed`);
    }
    if (!unchanged(await inspectUserGlobalSymlinkRemoval(inspection.path, { ...options, managedInstallations: latest }))) throw changed();
  }
  // A swap for a real directory is caught by the last recheck above or refused by unlink (EISDIR/EPERM).
  // A remaining window: the link replaced by another symbolic link between that recheck and this unlink
  // is still removed, because unlink cannot verify identity atomically. Only a link is ever unlinked.
  await unlink(inspection.path);
}

async function inspectStagedSkill(candidatePath: string, name: string, fileSystem: UserGlobalSkillFileSystem): Promise<UserGlobalSkillRemovalInspection> {
  const information = await realDirectory(candidatePath, "staged unmanaged Skill", fileSystem);
  const tree = await readUnmanagedTree(candidatePath, name, fileSystem);
  return {
    name,
    path: candidatePath,
    identity: fileIdentity(information),
    digest: skillTreeBaseline(tree).digest,
  };
}

async function restoreStagedSkill(
  stagingPath: string,
  targetPath: string,
  expected: UserGlobalSkillRemovalInspection,
  fileSystem: UserGlobalSkillFileSystem,
): Promise<boolean> {
  try {
    const staged = await inspectStagedSkill(stagingPath, expected.name, fileSystem);
    if (staged.identity !== expected.identity || staged.digest !== expected.digest) return false;
    await fileSystem.rename(stagingPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readUnmanagedTree(candidatePath: string, skillName: string, fileSystem: UserGlobalSkillFileSystem) {
  return readExistingSkillTree(candidatePath, skillName, fileSystem);
}

async function realDirectory(candidatePath: string, label: string, fileSystem: UserGlobalSkillFileSystem = nodeFileSystem): Promise<Stats> {
  const information = await fileSystem.lstat(candidatePath);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${candidatePath}; no path was changed`);
  }
  return information;
}

async function assertRealGlobalAncestors(homeDirectory: string, skillRoot: string, fileSystem: UserGlobalSkillFileSystem): Promise<void> {
  const relative = path.relative(homeDirectory, skillRoot);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Selected unmanaged Skill has an unsafe global ancestor: ${skillRoot}; no path was changed`);
  }
  await realDirectory(homeDirectory, "global home", fileSystem);
  let current = homeDirectory;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await realDirectory(current, "global Skill ancestor", fileSystem);
  }
}

function validateExplicitGlobalPath(candidatePath: string, homeDirectory: string): string {
  if (!path.isAbsolute(candidatePath) || candidatePath !== path.normalize(candidatePath)) {
    throw new Error(`Unmanaged Skill removal requires an exact normalized absolute global path: ${JSON.stringify(candidatePath)}; no path was changed`);
  }
  const root = GLOBAL_SKILL_ROOTS.find((candidate) => isUnderGlobalRoot(candidatePath, homeDirectory, candidate.kind === "agents" ? ".agents" : ".claude"));
  if (root === undefined) {
    throw new Error(`Unmanaged Skill path must be an immediate child under ${path.join(homeDirectory, ".agents", "skills")} or ${path.join(homeDirectory, ".claude", "skills")}: ${candidatePath}; no path was changed`);
  }
  if (isTransientName(path.basename(candidatePath))) {
    throw new Error(`Backup or transient paths are not unmanaged Skill removal candidates: ${candidatePath}; no path was changed`);
  }
  return candidatePath;
}

function managedProtectionPaths(homeDirectory: string, selections: readonly ProjectSkillSelection[]): readonly string[] {
  const protectedPaths = new Set<string>();
  for (const selection of selections) {
    const installationPath = selection.installation?.path;
    if (installationPath === undefined) continue;
    const absolutePath = resolveInstallationPath(homeDirectory, installationPath);
    if (absolutePath === undefined) continue;
    for (const alias of globalPathAliases(absolutePath)) protectedPaths.add(pathKey(alias));
  }
  return [...protectedPaths];
}

function globalPathAliases(candidatePath: string): readonly string[] {
  const resolved = path.resolve(candidatePath);
  const aliases = [resolved];
  if (isGlobalLocation(resolved, ".agents") || isGlobalLocation(resolved, ".claude")) {
    const rootName = isGlobalLocation(resolved, ".agents") ? ".agents" : ".claude";
    const otherRoot = rootName === ".agents" ? ".claude" : ".agents";
    aliases.push(path.join(path.dirname(path.dirname(path.dirname(resolved))), otherRoot, "skills", path.basename(resolved)));
  }
  return aliases;
}

function isGlobalLocation(candidatePath: string, rootName: ".agents" | ".claude"): boolean {
  const skillsPath = path.dirname(candidatePath);
  const globalRootPath = path.dirname(skillsPath);
  const expectedRootPath = path.join(path.dirname(globalRootPath), rootName);
  return pathKey(skillsPath) === pathKey(path.join(globalRootPath, "skills")) &&
    pathKey(globalRootPath) === pathKey(expectedRootPath);
}

function fileIdentity(information: Stats): string {
  const native = `${information.dev}:${information.ino}`;
  if (!information.isSymbolicLink()) {
    // A directory's content digest covers a replacement that reuses an inode.
    return native;
  }
  // A link has no content to digest and inode numbers are recycled, so add the
  // birth time and the link size (mirrors pathIdentityKey in project-installation).
  const birth = Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0 ? information.birthtimeMs : 0;
  return `${native}:${information.size}:${birth}`;
}

function skip(
  candidatePath: string,
  root: GlobalSkillRootKind,
  reason: UserGlobalSkillSkipReason,
  detail: string,
  name?: string,
): UserGlobalSkillInventorySkippedEntry {
  return { ...(name === undefined ? {} : { name }), path: candidatePath, root, reason, detail };
}

function resolveInstallationPath(homeDirectory: string, installationPath: string): string | undefined {
  const normalized = installationPath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized)) return undefined;
  const absolutePath = path.resolve(homeDirectory, ...normalized.split("/"));
  const relative = path.relative(homeDirectory, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return absolutePath;
}

function isUnderGlobalRoot(candidatePath: string, homeDirectory: string, directoryName: ".agents" | ".claude"): boolean {
  const rootPath = pathKey(path.join(homeDirectory, directoryName, "skills"));
  const relative = path.relative(rootPath, pathKey(candidatePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) &&
    !relative.includes(path.sep);
}

function pathKey(candidatePath: string): string {
  return path.normalize(path.resolve(candidatePath)).toLowerCase();
}

function isTransientName(name: string): boolean {
  const normalized = name.toLowerCase();
  return /^\.agent-depot-(?:backup|update|overwrite|stage|staging|temp|tmp)(?:-|$)/u.test(normalized) ||
    /\.agent-depot-unmanaged-stage-(?:[0-9a-f-]+)$/u.test(normalized) ||
    normalized.endsWith(".tmp");
}

function sameManagedInstallations(left: readonly ProjectSkillSelection[], right: readonly ProjectSkillSelection[]): boolean {
  return left.map((selection) => JSON.stringify(selection)).sort().join("\n") ===
    right.map((selection) => JSON.stringify(selection)).sort().join("\n");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
