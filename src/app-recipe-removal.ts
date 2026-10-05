import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import type { AppEntry, AppOperations } from "./app-flow.js";
import { assertNoSymlinkPath } from "./path-safety.js";

interface RecipeIdentity {
  readonly device: number;
  readonly inode: number;
  readonly hash: string;
  readonly link?: string;
}

function sameIdentity(left: RecipeIdentity, right: RecipeIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.hash === right.hash && left.link === right.link;
}

export interface AppRecipeRemovalPlan {
  readonly entry: AppEntry;
  readonly file: string;
  readonly identity: RecipeIdentity;
  readonly installed: boolean;
  readonly installedVersion?: string;
}

async function recipeIdentity(file: string): Promise<RecipeIdentity> {
  await assertNoSymlinkPath(path.dirname(file), "App recipes directory");
  const info = await lstat(file);
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error("App recipe is not a file or symbolic link");
  // A symlink is removed as a link, never by unlinking its target.
  const link = info.isSymbolicLink() ? await readlink(file) : undefined;
  const bytes = await readFile(file);
  return { device: info.dev, inode: info.ino, hash: createHash("sha256").update(bytes).digest("hex"),
    ...(link === undefined ? {} : { link }) };
}

/** Explicit removal may check version, but never runs an unapproved recipe. */
export async function planAppRecipeRemoval(apps: AppOperations, entry: AppEntry): Promise<AppRecipeRemovalPlan> {
  const file = path.resolve(entry.file);
  if (path.dirname(file) !== path.resolve(apps.directory)) throw new Error("App recipe is outside the recipes directory");
  const identity = await recipeIdentity(file);
  const [current] = await apps.load([file]);
  if (current.error || !current.recipe) throw new Error(`Cannot verify App state: ${current.error ?? "invalid recipe"}. Repair the recipe before removing it.`);
  if (current.hash !== entry.hash || current.canonicalFile !== entry.canonicalFile) throw new Error("App recipe changed; review it again");
  const tracked = (await apps.trackedApps()).find((record) => record.name === current.recipe!.name);
  const inspection = await apps.inspect(current);
  if (inspection.status !== "installed" && inspection.status !== "not installed" && inspection.status !== "not applicable here") {
    throw new Error(`Cannot verify App state (${inspection.status}); approve the recipe before removing it`);
  }
  // Nothing resolved a version executable, so installed state was never verified.
  if (inspection.status === "not installed" && (inspection.executable === undefined || inspection.reason !== undefined)) {
    throw new Error(`Cannot verify App state: the version command for ${current.recipe!.name} did not run. Make it available, then remove the recipe.`);
  }
  const installed = inspection.status === "installed" || tracked !== undefined;
  return Object.freeze({ entry: current, file, identity, installed,
    installedVersion: inspection.installedVersion ?? tracked?.installedVersion });
}

/** Rechecks content, inode and symlink target before any unlink; the live version read is a window. */
async function assertRecipeUnchanged(plan: AppRecipeRemovalPlan): Promise<void> {
  const identity = await recipeIdentity(plan.file);
  const canonicalFile = await realpath(plan.file);
  if (!sameIdentity(identity, plan.identity) || canonicalFile !== plan.entry.canonicalFile) {
    throw new Error("App recipe changed after preview; removal cancelled");
  }
}

/** Rechecks the preview and installed state before unlinking only the recipe path. */
export async function removeAppRecipe(apps: AppOperations, plan: AppRecipeRemovalPlan, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error("App recipe removal must be confirmed");
  if (path.dirname(plan.file) !== path.resolve(apps.directory)) throw new Error("App recipe is outside the recipes directory");
  await assertRecipeUnchanged(plan);
  const current = await planAppRecipeRemoval(apps, plan.entry);
  if (current.installed) throw new Error("App is still installed or tracked; uninstall it before removing its recipe");
  await assertRecipeUnchanged(plan);
  await unlink(plan.file);
}
