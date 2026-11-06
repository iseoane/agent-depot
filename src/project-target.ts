import { stat } from "node:fs/promises";
import path from "node:path";

import { assertNoSymlinkPath } from "./path-safety.js";
import type { ProjectHost } from "./project-manifest.js";
import { CliUsageError } from "./usage-error.js";

/**
 * Where each Host keeps project-level configuration. `.agents` is the canonical
 * Skill location the Hosts share, so it also marks a project that already uses Skills.
 */
const HOST_PROJECT_DIRECTORIES: Readonly<Record<ProjectHost, string>> = {
  pi: ".pi",
  claude: ".claude",
  codex: ".codex",
  opencode: ".opencode",
};
const PROJECT_DIRECTORIES: readonly string[] = [".agents", ...Object.values(HOST_PROJECT_DIRECTORIES)];

/** The warnings are advisory, so an entry that cannot be read counts as absent. */
async function exists(candidate: string): Promise<boolean> {
  return stat(candidate).then(() => true, () => false);
}

/**
 * Nearest ancestor-or-self holding a `.git` entry. A file marks a linked
 * worktree or submodule, so any `.git` entry counts. Walking the filesystem
 * avoids spawning `git` and cannot reach the network.
 */
async function findGitTopLevel(start: string): Promise<string | undefined> {
  for (let current = start; ; current = path.dirname(current)) {
    if (await exists(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * The lines every project-scope preview starts with: the project root the
 * Skills are installed into, then non-blocking warnings about a root that is
 * probably not the intended one. A brand-new project is legitimate, so nothing
 * here refuses.
 */
export async function describeProjectTarget(projectRoot: string, manifestPath: string): Promise<readonly string[]> {
  const lines = [`Project: ${projectRoot}`];
  const gitTopLevel = await findGitTopLevel(projectRoot);
  if (gitTopLevel !== undefined && path.relative(gitTopLevel, projectRoot) !== "") {
    lines.push(`  WARNING: this directory is inside the Git repository at ${gitTopLevel} but is not its top level; Skills will be installed here, not at the repository root`);
  }
  const markers = [manifestPath, ...PROJECT_DIRECTORIES.map((directory) => path.join(projectRoot, directory))];
  if (!(await Promise.all(markers.map(exists))).some(Boolean)) {
    lines.push(`  WARNING: this directory has no project manifest (${path.basename(manifestPath)}) and none of ${PROJECT_DIRECTORIES.join(", ")}; confirm it is the intended project directory`);
  }
  return lines;
}

/** Resolves a `--project` value against the working directory; it must be an existing directory without symbolic links. */
export async function resolveProjectRootOption(value: string): Promise<string> {
  const root = path.resolve(value);
  const information = await stat(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new CliUsageError(`--project ${JSON.stringify(value)} does not exist`);
    }
    throw error;
  });
  if (!information.isDirectory()) throw new CliUsageError(`--project ${JSON.stringify(value)} is not a directory`);
  await assertNoSymlinkPath(root, "--project");
  return root;
}
