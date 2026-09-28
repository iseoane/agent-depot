import { lstat, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defaultGitSourceCachePath,
  GitSourceSnapshotAccess,
} from "./git-source.js";
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

/** Reads one immutable view of a Source without refreshing or changing it. */
export interface SourceContentAccess {
  readSnapshot(source: Source): Promise<readonly SourceContentFile[]>;
}

export interface SourceContentAccessOptions {
  readonly builtInRoot?: string;
  readonly gitCachePath?: string;
}

/**
 * The package-owned root used for built-in skills. A missing root is an empty
 * built-in Source, which lets packages ship no built-in skills yet.
 */
export function defaultBuiltInSkillsRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

/** Default read-only Source access used by the application operation. */
export class NodeSourceContentAccess implements SourceContentAccess {
  private readonly builtInRoot: string;
  private readonly gitSnapshots: GitSourceSnapshotAccess;

  constructor(options: SourceContentAccessOptions = {}) {
    this.builtInRoot = options.builtInRoot ?? defaultBuiltInSkillsRoot();
    this.gitSnapshots = new GitSourceSnapshotAccess({
      cachePath: options.gitCachePath ?? defaultGitSourceCachePath(),
    });
  }

  async readSnapshot(source: Source): Promise<readonly SourceContentFile[]> {
    if (source.kind === "builtin") {
      return readDirectorySnapshot(this.builtInRoot);
    }
    return this.gitSnapshots.readSnapshot(source);
  }
}

export function createSourceContentAccess(options: SourceContentAccessOptions = {}): SourceContentAccess {
  return new NodeSourceContentAccess(options);
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

/** Parses the required YAML frontmatter fields without evaluating arbitrary YAML. */
export function parseSkillFrontmatter(content: string): { name: string; description: string } | undefined {
  const lines = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (!/^---\s*$/u.test(lines[0] ?? "")) {
    return undefined;
  }

  const values = new Map<string, string>();
  let index = 1;
  let closed = false;
  while (index < lines.length) {
    const line = lines[index];
    if (/^(?:---|\.\.\.)\s*$/u.test(line)) {
      closed = true;
      break;
    }
    if (line.trim() === "" || /^\s*#/u.test(line)) {
      index += 1;
      continue;
    }

    const match = /^(?<key>[A-Za-z][A-Za-z0-9_-]*)\s*:\s*(?<value>.*)$/u.exec(line);
    if (!match || line.startsWith(" ") || line.startsWith("\t")) {
      return undefined;
    }
    const key = match.groups?.key;
    const rawValue = match.groups?.value ?? "";
    if (!key) {
      return undefined;
    }

    if (/^[|>][+-]?\d*\s*$/u.test(rawValue)) {
      const folded = rawValue.startsWith(">");
      index += 1;
      const block: string[] = [];
      while (index < lines.length) {
        const blockLine = lines[index];
        if (blockLine.trim() !== "" && !/^[ \t]/u.test(blockLine)) {
          break;
        }
        block.push(blockLine);
        index += 1;
      }
      values.set(key, normalizeBlockScalar(block, folded));
      continue;
    }

    const scalar = parseScalar(rawValue);
    if (scalar === undefined) {
      return undefined;
    }
    values.set(key, scalar);
    index += 1;
  }

  if (!closed) {
    return undefined;
  }
  const name = values.get("name")?.trim();
  const description = values.get("description")?.trim();
  if (!name || !description) {
    return undefined;
  }
  return { name, description };
}

async function readDirectorySnapshot(root: string): Promise<readonly SourceContentFile[]> {
  const rootKind = await safePathKind(root);
  if (rootKind === "missing") {
    return Object.freeze([]);
  }
  if (rootKind !== "directory") {
    throw new Error(`Built-in Source root is not a directory: ${root}`);
  }

  const files: SourceContentFile[] = [];
  await walkDirectory(root, "", files);
  return Object.freeze(files);
}

async function walkDirectory(root: string, relativeDirectory: string, files: SourceContentFile[]): Promise<void> {
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
      await walkDirectory(root, relativePath, files);
      continue;
    }
    if (!entry.isFile() || (await safePathKind(absolutePath)) !== "file") {
      continue;
    }
    files.push({
      path: relativePath.split(path.sep).join("/"),
      content: await readFile(absolutePath, "utf8"),
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

function parseScalar(rawValue: string): string | undefined {
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
  if (!plain || /^(?:null|~|true|false|\[|\{|\]|\})$/iu.test(plain)) {
    return undefined;
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

