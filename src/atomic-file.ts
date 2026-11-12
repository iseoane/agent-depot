import { randomUUID } from "node:crypto";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface AtomicWriteOptions {
  readonly mode?: number;
  /** Only locked state writers may use the legacy Windows replacement fallback. */
  readonly allowLockedReplaceFallback?: boolean;
}

export const WINDOWS_RENAME_ATTEMPTS = 20;
const WINDOWS_RENAME_RETRY_MS = 5;

interface RenameRetryDeps {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly delay: (milliseconds: number) => Promise<unknown>;
}

/**
 * Windows reports EPERM, EACCES or EBUSY when a rename targets a file another rename or reader is
 * still releasing, so concurrent writers to one destination must retry briefly instead of failing.
 * The dependencies are injectable only so tests can force the Windows branch on any OS.
 */
export async function renameWithWindowsRetry(
  from: string,
  to: string,
  deps: RenameRetryDeps = { rename, platform: process.platform, delay },
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = deps.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code ?? "");
      if (!transient || attempt >= WINDOWS_RENAME_ATTEMPTS) throw error;
      await deps.delay(WINDOWS_RENAME_RETRY_MS * attempt);
    }
  }
}

/** Persist a directory entry change; Windows cannot open a directory for fsync. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems do not implement fsync on directories.
    if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

/** Write a unique temporary sibling, fsync it, publish it with rename, then fsync the directory. */
export async function writeFileAtomically(
  file: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporaryPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", options.mode);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithWindowsRetry(temporaryPath, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!options.allowLockedReplaceFallback || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(code ?? "")) {
        throw error;
      }
      // Source state holds its read-modify-write lock while using this Windows fallback.
      await writeFile(file, contents, "utf8");
    }
    await syncDirectory(path.dirname(file));
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/**
 * Whether a failed `mkdir` of a lock directory means another process holds it. Windows reports
 * EPERM or EACCES instead of EEXIST while the holder's `rmdir` is still completing, so a concurrent
 * waiter must retry rather than fail.
 */
export function isLockContention(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "EEXIST" || (platform === "win32" && (code === "EPERM" || code === "EACCES"));
}
