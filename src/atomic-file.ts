import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

interface AtomicWriteOptions {
  readonly mode?: number;
  /** Only locked state writers may use the legacy Windows replacement fallback. */
  readonly allowLockedReplaceFallback?: boolean;
}

const WINDOWS_RENAME_ATTEMPTS = 20;
const WINDOWS_RENAME_RETRY_MS = 5;

/**
 * Windows reports EPERM, EACCES or EBUSY when a rename targets a file another rename or reader is
 * still releasing, so concurrent writers to one destination must retry briefly instead of failing.
 */
async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code ?? "");
      if (!transient || attempt >= WINDOWS_RENAME_ATTEMPTS) throw error;
      await delay(WINDOWS_RENAME_RETRY_MS * attempt);
    }
  }
}

/** Write a unique temporary sibling, then publish it with rename. */
export async function writeFileAtomically(
  file: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporaryPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: options.mode });
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
