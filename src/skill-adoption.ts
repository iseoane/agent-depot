import type { Stats } from "node:fs";
import path from "node:path";

import type { SkillTreeFile } from "./skill-discovery.js";

/** The minimal filesystem seam needed to inspect an existing Skill in place. */
export interface SkillTreeFileSystem {
  lstat(candidate: string): Promise<Stats>;
  readdir(candidate: string): Promise<readonly string[]>;
  readFile(candidate: string): Promise<Uint8Array>;
}

export type SkillTreeComparisonReason =
  | "missing-file"
  | "extra-file"
  | "content-mismatch"
  | "unsafe-file";

export interface SkillTreeComparison {
  readonly identical: boolean;
  readonly reason?: SkillTreeComparisonReason;
}

/**
 * Compares immutable tree entries without decoding or normalizing their bytes.
 * Executable metadata is intentionally not part of content identity: adoption
 * must recognize the same files even when a checkout chose different modes.
 */
export function compareSkillTrees(
  expected: readonly SkillTreeFile[],
  actual: readonly SkillTreeFile[],
): SkillTreeComparison {
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.map((file) => [file.path, file]));

  for (const file of expected) {
    const candidate = actualByPath.get(file.path);
    if (!candidate) return { identical: false, reason: "missing-file" };
    if (!sameBytes(file.content, candidate.content)) {
      return { identical: false, reason: "content-mismatch" };
    }
  }
  for (const file of actual) {
    if (!expectedByPath.has(file.path)) return { identical: false, reason: "extra-file" };
  }
  return { identical: true };
}

/** Reads one existing Skill tree while refusing to follow any symlink. */
export async function readExistingSkillTree(
  skillRoot: string,
  sourceSkillPath: string,
  fileSystem: SkillTreeFileSystem,
): Promise<readonly SkillTreeFile[]> {
  const rootInformation = await fileSystem.lstat(skillRoot);
  assertRealDirectory(skillRoot, rootInformation);
  const files: SkillTreeFile[] = [];
  await walkExistingTree(skillRoot, sourceSkillPath, "", files, fileSystem);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(files);
}

async function walkExistingTree(
  skillRoot: string,
  sourceSkillPath: string,
  relativeDirectory: string,
  files: SkillTreeFile[],
  fileSystem: SkillTreeFileSystem,
): Promise<void> {
  const current = relativeDirectory === "" ? skillRoot : path.join(skillRoot, ...relativeDirectory.split("/"));
  const entries = [...await fileSystem.readdir(current)].sort((left, right) => left.localeCompare(right));
  for (const entry of entries) {
    if (!isSafeEntry(entry)) {
      throw new Error(`Existing Skill contains an unsafe path entry: ${entry}`);
    }
    const relativePath = relativeDirectory === "" ? entry : `${relativeDirectory}/${entry}`;
    const candidate = path.join(skillRoot, ...relativePath.split("/"));
    const information = await fileSystem.lstat(candidate);
    if (information.isSymbolicLink()) {
      throw new Error(`Existing Skill contains a symbolic link: ${relativePath}`);
    }
    if (information.isDirectory()) {
      await walkExistingTree(skillRoot, sourceSkillPath, relativePath, files, fileSystem);
      continue;
    }
    if (!information.isFile()) {
      throw new Error(`Existing Skill contains a non-regular file: ${relativePath}`);
    }
    files.push({
      path: `${sourceSkillPath}/${relativePath}`,
      content: Uint8Array.from(await fileSystem.readFile(candidate)),
      executable: (information.mode & 0o111) !== 0,
    });
  }
}

function assertRealDirectory(candidate: string, information: Stats): void {
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error(`Existing Skill is not a real directory: ${candidate}`);
  }
}

function isSafeEntry(candidate: string): boolean {
  return candidate.length > 0 && candidate !== "." && candidate !== ".." &&
    !candidate.includes("/") && !candidate.includes("\\") && !candidate.includes("\u0000");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
