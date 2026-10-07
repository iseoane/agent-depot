import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { assertNoSymlinkPath } from "./path-safety.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defaultGitSourceCachePath,
  GitSourceSnapshotAccess,
  isSourceSnapshotFile,
  SKILL_TREE_LIMITS,
  validateSkillDirectoryPath,
  type GitSourceSkillTreeSnapshot,
} from "./git-source.js";
import {
  AGENT_DEPOT_PACKAGE_VERSION,
  type ResolvedVersionEvidence,
  type SkillInstallationBaseline,
} from "./project-manifest.js";
import type { Source } from "./sources.js";

export const EXCLUDED_LIFECYCLE_SEGMENTS = Object.freeze([
  "in-progress",
  "beta",
  "deprecated",
  "retired",
]);

const excludedLifecycleSegments = new Set(EXCLUDED_LIFECYCLE_SEGMENTS);

export interface SkillCandidate {
  readonly sourceId: string;
  /** POSIX path to the directory containing SKILL.md, relative to the Source root. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
}

export interface SourceContentFile {
  /** POSIX path relative to the Source root. */
  readonly path: string;
  readonly content: string;
}

export interface SkillTreeFile {
  /** POSIX path relative to the Source root. */
  readonly path: string;
  /** Exact file bytes; callers must not decode or normalize supporting files. */
  readonly content: Uint8Array;
  /** Whether the source marked this file executable. */
  readonly executable: boolean;
}

export interface SourceSkillTreeSnapshot {
  readonly files: readonly SkillTreeFile[];
  /** Version evidence captured from the same immutable Source view as files. */
  readonly resolvedVersion?: ResolvedVersionEvidence;
}

/** Reads one immutable view of a Source without refreshing or changing it. */
export interface SourceContentAccess {
  readSnapshot(source: Source): Promise<readonly SourceContentFile[]>;
  readonly readSkillTree?: (source: Source, skillPath: string) => Promise<readonly SkillTreeFile[]>;
  readonly readSkillTreeSnapshot?: (source: Source, skillPath: string) => Promise<SourceSkillTreeSnapshot>;
  /** Reads trustworthy version evidence without replacing the immutable Source view. */
  readonly readResolvedVersion?: (source: Source) => Promise<ResolvedVersionEvidence | undefined>;
  /** Proves commit ordering from cached Git history without refreshing or fetching. */
  readonly isCommitAncestor?: (source: Source, olderCommit: string, newerCommit: string) => Promise<boolean | undefined>;
}

export interface SourceContentAccessOptions {
  readonly builtInRoot?: string;
  readonly gitCachePath?: string;
  readonly readFile?: (filePath: string) => Promise<string>;
  readonly readBinaryFile?: (filePath: string) => Promise<Uint8Array>;
}

/**
 * The package-owned root used for built-in skills. A missing root is an empty
 * built-in Source, which lets packages ship no built-in skills yet.
 */
export function defaultBuiltInSkillsRoot(): string {
  return path.join(findPackageRoot(path.dirname(fileURLToPath(import.meta.url))), "skills");
}

/** Walks up from a module directory (src/ or dist/src/) to the nearest package.json. */
function findPackageRoot(startDirectory: string): string {
  let current = startDirectory;
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDirectory, "..");
    }
    current = parent;
  }
}

/** Default read-only Source access used by the application operation. */
export class NodeSourceContentAccess implements SourceContentAccess {
  private readonly builtInRoot: string;
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly readBinaryFile: (filePath: string) => Promise<Uint8Array>;
  private readonly gitSnapshots: GitSourceSnapshotAccess;

  constructor(options: SourceContentAccessOptions = {}) {
    this.builtInRoot = options.builtInRoot ?? defaultBuiltInSkillsRoot();
    this.readFile = options.readFile ?? ((filePath) => readFile(filePath, "utf8"));
    this.readBinaryFile = options.readBinaryFile ?? ((filePath) => readFile(filePath));
    this.gitSnapshots = new GitSourceSnapshotAccess({
      cachePath: options.gitCachePath ?? defaultGitSourceCachePath(),
    });
  }

  async readSnapshot(source: Source): Promise<readonly SourceContentFile[]> {
    if (source.kind === "builtin") {
      return readDirectorySnapshot(this.builtInRoot, this.readFile);
    }
    return this.gitSnapshots.readSnapshot(source);
  }

  async readSkillTree(source: Source, skillPath: string): Promise<readonly SkillTreeFile[]> {
    return (await this.readSkillTreeSnapshot(source, skillPath)).files;
  }

  async readSkillTreeSnapshot(source: Source, skillPath: string): Promise<SourceSkillTreeSnapshot> {
    const selectedPath = validateSkillDirectoryPath(skillPath);
    if (source.kind === "builtin") {
      return Object.freeze({
        files: await readSelectedSkillDirectory(this.builtInRoot, selectedPath, this.readBinaryFile),
        ...(AGENT_DEPOT_PACKAGE_VERSION === undefined
          ? {}
          : { resolvedVersion: Object.freeze({ kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION }) }),
      });
    }
    const snapshot: GitSourceSkillTreeSnapshot = await this.gitSnapshots.readSkillTreeSnapshot(source, selectedPath);
    return Object.freeze({
      files: snapshot.files,
      resolvedVersion: Object.freeze({ kind: "git-commit", commit: snapshot.resolvedVersion }),
    });
  }

  async isCommitAncestor(source: Source, olderCommit: string, newerCommit: string): Promise<boolean | undefined> {
    if (source.kind === "builtin") return undefined;
    return this.gitSnapshots.isAncestor(source, olderCommit, newerCommit);
  }

  async readResolvedVersion(source: Source): Promise<ResolvedVersionEvidence | undefined> {
    if (source.kind === "builtin") {
      return AGENT_DEPOT_PACKAGE_VERSION === undefined
        ? undefined
        : Object.freeze({ kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION });
    }
    return Object.freeze({
      kind: "git-commit",
      commit: await this.gitSnapshots.readResolvedCommit(source),
    });
  }
}

export function createSourceContentAccess(options: SourceContentAccessOptions = {}): SourceContentAccess {
  return new NodeSourceContentAccess(options);
}

/**
 * Creates a deterministic content baseline for a safely captured Skill tree.
 * Paths and bytes are included; executable mode is intentionally excluded so
 * adoption and update checks use the same content identity across platforms.
 */
export function skillTreeBaseline(files: readonly SkillTreeFile[]): SkillInstallationBaseline {
  const sorted = [...files].sort((left, right) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  ));
  const seen = new Set<string>();
  const hash = createHash("sha256");
  hash.update("agent-depot-skill-tree-v1\0", "utf8");
  for (const file of sorted) {
    if (seen.has(file.path)) {
      throw new Error(`Skill tree contains a duplicate path: ${file.path}`);
    }
    seen.add(file.path);
    const pathBytes = Buffer.from(file.path, "utf8");
    hash.update(`${pathBytes.byteLength}:`, "utf8");
    hash.update(pathBytes);
    hash.update(`${file.content.byteLength}:`, "utf8");
    hash.update(file.content);
    hash.update("\0", "utf8");
  }
  return Object.freeze({ algorithm: "sha256", digest: hash.digest("hex") });
}

/** Discovers candidates from explicitly selected Sources in selection order. */
export async function discoverSkillsFromSources(
  sources: readonly Source[],
  contentAccess: SourceContentAccess,
): Promise<readonly SkillCandidate[]> {
  const candidates: SkillCandidate[] = [];
  for (const source of sources) {
    const files = [...await contentAccess.readSnapshot(source)].sort((left, right) => left.path.localeCompare(right.path));
    for (const file of files) {
      const normalizedPath = normalizeSourcePath(file.path);
      if (!normalizedPath || path.posix.basename(normalizedPath) !== "SKILL.md") {
        continue;
      }

      const directoryPath = path.posix.dirname(normalizedPath);
      const segments = directoryPath === "." ? [] : directoryPath.split("/");
      if (segments.some((segment) => excludedLifecycleSegments.has(segment))) {
        continue;
      }

      const metadata = parseSkillFrontmatter(file.content);
      if (!metadata) {
        continue;
      }
      candidates.push({
        sourceId: source.id,
        path: directoryPath,
        name: metadata.name,
        description: metadata.description,
      });
    }
  }
  return Object.freeze(candidates);
}

/** Collects scalar frontmatter values up to the closing delimiter; undefined when malformed or unclosed. */
function readFrontmatterValues(lines: readonly string[]): Map<string, string | boolean> | undefined {
  const values = new Map<string, string | boolean>();
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (/^(?:---|\.\.\.)\s*$/u.test(line)) {
      return values;
    }
    if (line.trim() === "" || /^\s*#/u.test(line)) {
      index += 1;
      continue;
    }
    const next = readFrontmatterEntry(lines, index, values);
    if (next === undefined) {
      return undefined;
    }
    index = next;
  }
  return undefined;
}

/** Reads one top-level entry starting at index and returns the next index, or undefined when malformed. */
function readFrontmatterEntry(lines: readonly string[], index: number, values: Map<string, string | boolean>): number | undefined {
  const line = lines[index];
  const match = /^(?<key>[A-Za-z][A-Za-z0-9_-]*)\s*:\s*(?<value>.*)$/u.exec(line);
  if (!match || line.startsWith(" ") || line.startsWith("\t")) {
    return undefined;
  }
  const key = match.groups?.key;
  const rawValue = match.groups?.value ?? "";
  if (!key) {
    return undefined;
  }

  if (key === "metadata" && rawValue.trim() === "") {
    return consumeNestedMapping(lines, index + 1);
  }

  if (/^[|>][+-]?\d*\s*$/u.test(rawValue)) {
    const block: string[] = [];
    let next = index + 1;
    while (next < lines.length) {
      const blockLine = lines[next];
      if (blockLine.trim() !== "" && !/^[ \t]/u.test(blockLine)) {
        break;
      }
      block.push(blockLine);
      next += 1;
    }
    values.set(key, normalizeBlockScalar(block, rawValue.startsWith(">")));
    return next;
  }

  const scalar = parseScalar(rawValue);
  if (scalar === undefined) {
    return undefined;
  }
  values.set(key, scalar);
  return index + 1;
}

/** Parses the required YAML frontmatter fields without evaluating arbitrary YAML. */
export function parseSkillFrontmatter(content: string): { name: string; description: string } | undefined {
  const lines = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (!/^---\s*$/u.test(lines[0] ?? "")) {
    return undefined;
  }

  const values = readFrontmatterValues(lines);
  if (!values) {
    return undefined;
  }
  const nameValue = values.get("name");
  const descriptionValue = values.get("description");
  const name = typeof nameValue === "string" ? nameValue.trim() : undefined;
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : undefined;
  if (!name || !description) {
    return undefined;
  }
  return { name, description };
}

async function readSelectedSkillDirectory(
  root: string,
  selectedPath: string,
  readBinaryFile: (filePath: string) => Promise<Uint8Array>,
): Promise<readonly SkillTreeFile[]> {
  const rootKind = await safePathKind(root);
  if (rootKind !== "directory") {
    throw new Error(`Built-in Source root is not a directory: ${root}`);
  }
  await assertNoSymlinkPath(root, "Selected Skill path");

  const selectedDirectory = path.join(root, ...selectedPath.split("/"));
  if ((await safePathKind(selectedDirectory)) !== "directory") {
    throw new Error(`Selected Skill directory is not available: ${selectedPath}`);
  }
  await assertNoSymlinkPath(selectedDirectory, "Selected Skill path");

  const files: SkillTreeFile[] = [];
  let totalBytes = 0;
  let hasSkillManifest = false;
  await walkSelectedSkillDirectory(
    root,
    selectedDirectory,
    selectedPath,
    files,
    readBinaryFile,
    (byteLength, relativePath) => {
      if (byteLength > SKILL_TREE_LIMITS.maxFileBytes) {
        throw new Error(`Selected Skill file exceeds the safe size limit: ${relativePath}`);
      }
    },
    (byteLength) => {
      totalBytes += byteLength;
      if (totalBytes > SKILL_TREE_LIMITS.maxTotalBytes) {
        throw new Error("Selected Skill tree exceeds the safe total size limit");
      }
    },
    () => {
      if (files.length >= SKILL_TREE_LIMITS.maxFiles) {
        throw new Error("Selected Skill tree contains too many files");
      }
    },
    (relativePath) => {
      if (relativePath === `${selectedPath}/SKILL.md`) {
        hasSkillManifest = true;
      }
    },
  );

  if (!hasSkillManifest) {
    throw new Error(`Selected Skill directory does not contain ${selectedPath}/SKILL.md`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(files);
}

async function walkSelectedSkillDirectory(
  root: string,
  absoluteDirectory: string,
  relativeDirectory: string,
  files: SkillTreeFile[],
  readBinaryFile: (filePath: string) => Promise<Uint8Array>,
  assertFileSize: (byteLength: number, relativePath: string) => void,
  assertTotalBytes: (byteLength: number) => void,
  assertFileCount: () => void,
  observeFile: (relativePath: string) => void,
): Promise<void> {
  await assertNoSymlinkPath(absoluteDirectory, "Selected Skill path");
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    try {
      validateSkillDirectoryPath(relativePath);
    } catch {
      throw new Error(`Selected Skill tree contains an unsafe path: ${relativePath}`);
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (entry.isSymbolicLink()) {
      throw new Error(`Selected Skill tree contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if ((await safePathKind(absolutePath)) !== "directory") {
        throw new Error(`Selected Skill tree entry changed while reading: ${relativePath}`);
      }
      await walkSelectedSkillDirectory(
        root,
        absolutePath,
        relativePath,
        files,
        readBinaryFile,
        assertFileSize,
        assertTotalBytes,
        assertFileCount,
        observeFile,
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Selected Skill tree contains an unsupported file: ${relativePath}`);
    }

    assertFileCount();
    await assertNoSymlinkPath(absolutePath, "Selected Skill path");
    const information = await lstat(absolutePath);
    if (!information.isFile()) {
      throw new Error(`Selected Skill tree entry changed while reading: ${relativePath}`);
    }
    assertFileSize(information.size, relativePath);
    const content = await readBinaryFile(absolutePath);
    const byteLength = content.byteLength;
    assertFileSize(byteLength, relativePath);
    assertTotalBytes(byteLength);
    observeFile(relativePath);
    files.push({ path: relativePath, content, executable: (information.mode & 0o111) !== 0 });
  }
}

async function readDirectorySnapshot(
  root: string,
  readTextFile: (filePath: string) => Promise<string>,
): Promise<readonly SourceContentFile[]> {
  const rootKind = await safePathKind(root);
  if (rootKind === "missing") {
    return Object.freeze([]);
  }
  if (rootKind !== "directory") {
    throw new Error(`Built-in Source root is not a directory: ${root}`);
  }

  const files: SourceContentFile[] = [];
  await walkDirectory(root, "", files, readTextFile);
  return Object.freeze(files);
}

async function walkDirectory(
  root: string,
  relativeDirectory: string,
  files: SourceContentFile[],
  readTextFile: (filePath: string) => Promise<string>,
): Promise<void> {
  const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (excludedLifecycleSegments.has(entry.name)) {
        continue;
      }
      await walkDirectory(root, relativePath, files, readTextFile);
      continue;
    }
    if (!entry.isFile() || !isSourceSnapshotFile(relativePath) || (await safePathKind(absolutePath)) !== "file") {
      continue;
    }
    files.push({
      path: relativePath.split(path.sep).join("/"),
      content: await readTextFile(absolutePath),
    });
  }
}

async function safePathKind(candidate: string): Promise<"directory" | "file" | "missing" | "symlink"> {
  try {
    const information = await lstat(candidate);
    if (information.isSymbolicLink()) {
      return "symlink";
    }
    if (information.isDirectory()) {
      return "directory";
    }
    return "file";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function normalizeSourcePath(candidate: string): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\\")) {
    return undefined;
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

const MAX_NESTED_MAPPING_DEPTH = 32;

function consumeNestedMapping(lines: readonly string[], start: number, depth = 0): number | undefined {
  if (depth > MAX_NESTED_MAPPING_DEPTH) {
    return undefined;
  }

  let index = start;
  let indentation: number | undefined;
  let hasEntry = false;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/u.test(line)) {
      index += 1;
      continue;
    }
    if (/^(?:---|\.\.\.)\s*$/u.test(line) || !/^\s/u.test(line)) {
      break;
    }
    if (/^\t/u.test(line)) {
      return undefined;
    }

    const lineIndentation = line.match(/^ */u)?.[0].length ?? 0;
    indentation ??= lineIndentation;
    if (lineIndentation !== indentation) {
      return undefined;
    }

    const next = consumeNestedEntry(lines, index, indentation, depth);
    if (next === undefined) {
      return undefined;
    }
    index = next;
    hasEntry = true;
  }

  return hasEntry ? index : undefined;
}

/** Consumes one nested mapping entry (scalar, block scalar or child mapping); undefined when malformed. */
function consumeNestedEntry(lines: readonly string[], index: number, indentation: number, depth: number): number | undefined {
  const match = /^ +(?<key>[A-Za-z][A-Za-z0-9_-]*)\s*:\s*(?<value>.*)$/u.exec(lines[index]);
  if (!match) {
    return undefined;
  }
  const rawValue = match.groups?.value ?? "";
  if (rawValue === "") {
    return consumeNestedMapping(lines, index + 1, depth + 1);
  }
  if (/^[|>][+-]?\d*\s*$/u.test(rawValue)) {
    return consumeNestedBlockScalar(lines, index + 1, indentation);
  }
  return parseScalar(rawValue) === undefined ? undefined : index + 1;
}

function consumeNestedBlockScalar(lines: readonly string[], start: number, indentation: number): number | undefined {
  let index = start;
  while (index < lines.length) {
    const blockLine = lines[index];
    if (blockLine.trim() !== "" && (!/^\s/u.test(blockLine) || (blockLine.match(/^ */u)?.[0].length ?? 0) <= indentation)) {
      break;
    }
    if (/^\t/u.test(blockLine)) {
      return undefined;
    }
    index += 1;
  }
  return index;
}

function parseScalar(rawValue: string): string | boolean | undefined {
  const value = rawValue.trim();
  if (value.startsWith("\"")) {
    if (!value.endsWith("\"") || value.length < 2) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      return undefined;
    }
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  const plain = value.replace(/\s+#.*$/u, "").trim();
  if (!plain || /^(?:null|~|\[|\{|\]|\})$/iu.test(plain)) {
    return undefined;
  }
  if (/^(?:true|false)$/iu.test(plain)) {
    return plain.toLowerCase() === "true";
  }
  return plain;
}

function normalizeBlockScalar(lines: readonly string[], folded: boolean): string {
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const indentation = nonEmpty.length === 0
    ? 0
    : Math.min(...nonEmpty.map((line) => line.match(/^[ \t]*/u)?.[0].length ?? 0));
  const normalized = lines.map((line) => line.slice(indentation));
  if (!folded) {
    return normalized.join("\n").trim();
  }
  return normalized.join("\n").replace(/\n(?=\S)/gu, " ").trim();
}

