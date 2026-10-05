import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultGitSourceCachePath,
  GitSourceSnapshotAccess,
  githubTreeLocation,
  validateSkillDirectoryPath,
  type GitSource,
} from "./git-source.js";
import { assertNoSymlinkPath } from "./path-safety.js";
import { defaultBuiltInSkillsRoot } from "./skill-discovery.js";
import type { Source } from "./sources.js";

/** Where a host must be pointed. Never a local mirror path: mirrors are bare. */
export type HostFacingOrigin =
  | {
      readonly kind: "git";
      /** Scheme-stripped repository URL, e.g. github.com/owner/repo. */
      readonly repositoryUrl: string;
      readonly ref?: string;
      /** Directory scope parsed from a GitHub tree URL, when there is one. */
      readonly directory?: string;
    }
  | { readonly kind: "builtin" };

/** One immutable read-only view of a Source. */
export interface PackageSourceView {
  readonly sourceId: string;
  readonly origin: HostFacingOrigin;
  /** Resolved immutable commit, when the Source is Git. */
  readonly resolvedCommit?: string;
  /** Paths whose basename is in `names`, at or under `root`. */
  find(root: string, names: readonly string[]): Promise<readonly string[]>;
  /** Every file path at or under `root`. */
  list(root: string): Promise<readonly string[]>;
  /** One file's text, or undefined when absent. */
  read(path: string): Promise<string | undefined>;
}

/** A port, not a wire type: no field here carries a filesystem path a host CLI could be given. */
export interface PackageContentAccess {
  readView(source: Source): Promise<PackageSourceView>;
}

export interface NodePackageContentAccessOptions {
  readonly builtInRoot?: string;
  readonly gitCachePath?: string;
}

export function createNodePackageContentAccess(options: NodePackageContentAccessOptions = {}): PackageContentAccess {
  return new NodePackageContentAccess(options);
}

class NodePackageContentAccess implements PackageContentAccess {
  private readonly builtInRoot: string;
  private readonly gitSnapshots: GitSourceSnapshotAccess;

  constructor(options: NodePackageContentAccessOptions = {}) {
    this.builtInRoot = options.builtInRoot ?? defaultBuiltInSkillsRoot();
    this.gitSnapshots = new GitSourceSnapshotAccess({
      cachePath: options.gitCachePath ?? defaultGitSourceCachePath(),
    });
  }

  async readView(source: Source): Promise<PackageSourceView> {
    return source.kind === "builtin" ? this.builtInView(source.id) : this.gitView(source);
  }

  private builtInView(sourceId: string): PackageSourceView {
    return {
      sourceId,
      origin: Object.freeze({ kind: "builtin" }),
      find: async (root, names) => filterByBasename(await listBuiltInFiles(this.builtInRoot, root), names),
      list: async (root) => listBuiltInFiles(this.builtInRoot, root),
      read: async (filePath) => readBuiltInFile(this.builtInRoot, filePath),
    };
  }

  private async gitView(source: GitSource): Promise<PackageSourceView> {
    const location = githubTreeLocation(source.url);
    const directory = location?.directory;
    const repositoryUrl = stripUrlScheme(location?.repositoryUrl ?? source.url);
    const ref = source.ref ?? location?.ref;
    const resolvedCommit = await this.gitSnapshots.readResolvedCommit(source);

    const toRepoPath = (sourcePath: string): string => {
      if (sourcePath === "") {
        return directory ?? "";
      }
      return directory === undefined ? sourcePath : `${directory}/${sourcePath}`;
    };
    const toSourcePath = (repoPath: string): string =>
      directory === undefined ? repoPath : repoPath.slice(directory.length + 1);

    return {
      sourceId: source.id,
      origin: Object.freeze({
        kind: "git",
        repositoryUrl,
        ...(ref === undefined ? {} : { ref }),
        ...(directory === undefined ? {} : { directory }),
      }),
      resolvedCommit,
      find: async (root, names) =>
        filterByBasename(await this.listSourcePaths(source, root, toRepoPath, toSourcePath), names),
      list: async (root) => Object.freeze(await this.listSourcePaths(source, root, toRepoPath, toSourcePath)),
      read: async (filePath) => this.gitSnapshots.readFile(source, toRepoPath(filePath)),
    };
  }

  private async listSourcePaths(
    source: GitSource,
    root: string,
    toRepoPath: (sourcePath: string) => string,
    toSourcePath: (repoPath: string) => string,
  ): Promise<readonly string[]> {
    const files = (await this.gitSnapshots.listFiles(source, toRepoPath(root))).map(toSourcePath);
    files.sort((left, right) => left.localeCompare(right));
    return files;
  }
}

/** Strips the scheme prefix, e.g. `https://github.com/owner/repo` becomes `github.com/owner/repo`. */
function stripUrlScheme(repositoryUrl: string): string {
  const separator = repositoryUrl.indexOf("://");
  return separator >= 0 ? repositoryUrl.slice(separator + 3) : repositoryUrl;
}

function filterByBasename(files: readonly string[], names: readonly string[]): readonly string[] {
  const wanted = new Set(names);
  return Object.freeze(files.filter((filePath) => wanted.has(path.posix.basename(filePath))));
}

type PathKind = "directory" | "file" | "missing" | "symlink";

async function pathKind(candidate: string): Promise<PathKind> {
  try {
    const information = await lstat(candidate);
    if (information.isSymbolicLink()) {
      return "symlink";
    }
    return information.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

async function listBuiltInFiles(root: string, selectedRoot: string): Promise<readonly string[]> {
  const relativeRoot = selectedRoot === "" ? "" : validateSkillDirectoryPath(selectedRoot);
  if ((await pathKind(root)) !== "directory") {
    throw new Error(`Built-in Source root is not a directory: ${root}`);
  }
  await assertNoSymlinkPath(root, "Built-in Source root");

  const selectedDirectory = relativeRoot === "" ? root : path.join(root, ...relativeRoot.split("/"));
  if (relativeRoot !== "") {
    if ((await pathKind(selectedDirectory)) !== "directory") {
      return Object.freeze([]);
    }
    await assertNoSymlinkPath(selectedDirectory, "Built-in Source path");
  }

  const files: string[] = [];
  await walkBuiltInFiles(root, relativeRoot, files);
  files.sort((left, right) => left.localeCompare(right));
  return Object.freeze(files);
}

async function readBuiltInFile(root: string, selectedPath: string): Promise<string | undefined> {
  const relativePath = validateSkillDirectoryPath(selectedPath);
  if ((await pathKind(root)) !== "directory") {
    throw new Error(`Built-in Source root is not a directory: ${root}`);
  }
  await assertNoSymlinkPath(root, "Built-in Source root");

  const absolutePath = path.join(root, ...relativePath.split("/"));
  if ((await pathKind(absolutePath)) !== "file") {
    return undefined;
  }
  await assertNoSymlinkPath(absolutePath, "Built-in Source path");
  return readFile(absolutePath, "utf8");
}

async function walkBuiltInFiles(root: string, relativeDirectory: string, files: string[]): Promise<void> {
  const absoluteDirectory = relativeDirectory === "" ? root : path.join(root, ...relativeDirectory.split("/"));
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    try {
      validateSkillDirectoryPath(relativePath);
    } catch {
      throw new Error(`Built-in Source contains an unsafe path: ${relativePath}`);
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      await assertNoSymlinkPath(absolutePath, "Built-in Source path");
      await walkBuiltInFiles(root, relativePath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await assertNoSymlinkPath(absolutePath, "Built-in Source path");
    files.push(relativePath);
  }
}
