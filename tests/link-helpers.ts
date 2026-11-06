import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * Create a directory link the way the product does: a junction on Windows (no privilege needed,
 * absolute target resolved against the link's directory) and a relative-preserving symlink elsewhere.
 */
export async function directoryLink(target: string, link: string): Promise<void> {
  if (process.platform === "win32") {
    await symlink(path.resolve(path.dirname(link), target), link, "junction");
    return;
  }
  await symlink(target, link, "dir");
}

let fileSymlinksAvailable: Promise<boolean> | undefined;

export function fileSymlinksSupported(): Promise<boolean> {
  fileSymlinksAvailable ??= (async () => {
    if (process.platform !== "win32") return true;
    const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-file-link-"));
    try {
      await symlink(path.join(directory, "target"), path.join(directory, "link"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return fileSymlinksAvailable;
}

/** Skip the current test when this Windows account may not create file symlinks (EPERM); never skips elsewhere. */
export async function skipWithoutFileSymlinks(t: TestContext): Promise<boolean> {
  if (await fileSymlinksSupported()) return false;
  t.skip("file symlinks need Windows Developer Mode or elevation (EPERM)");
  return true;
}
