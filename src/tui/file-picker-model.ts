import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** The portable Profile artifact extension; import shows only these files until `f`. */
export const PROFILE_EXTENSION = ".json";
/** The pre-filled export file name; `Ctrl+U` clears it and a missing extension gains `.json`. */
export const DEFAULT_PROFILE_FILE_NAME = "agent-depot-profile.json";

/** What the picker is for: `directory` selects a folder, `file` selects one existing file. */
export type PickerPurpose = "directory" | "file";

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: "directory" | "file";
}

export interface DirectoryListing {
  readonly directory: string;
  readonly parent: string | undefined;
  readonly entries: readonly DirectoryEntry[];
}

/** What the picker hands back; the caller decides what each selection means. */
export type PickerSelection =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "file"; readonly file: string; readonly directory: string };

/** The directory an export or import browser opens in. Tests inject `startDirectory`. */
export function pickerStartDirectory(environment: { readonly startDirectory?: string; readonly projectRoot?: string }): string {
  return path.resolve(environment.startDirectory ?? environment.projectRoot ?? process.cwd());
}

export function isProfileFileName(name: string): boolean {
  return path.extname(name).toLowerCase() === PROFILE_EXTENSION;
}

/** Directories first, then files, each in code-point order, so the list is stable across platforms. */
export function sortDirectoryEntries(entries: readonly DirectoryEntry[]): readonly DirectoryEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/** Read one directory into the picker's listing shape; symlinked directories are followed. */
export async function readDirectoryListing(directory: string): Promise<DirectoryListing> {
  const dirents = await readdir(directory, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    let isDirectory = dirent.isDirectory();
    if (!isDirectory && dirent.isSymbolicLink()) {
      try { isDirectory = (await stat(path.join(directory, dirent.name))).isDirectory(); }
      catch { isDirectory = false; }
    }
    entries.push({ name: dirent.name, kind: isDirectory ? "directory" : "file" });
  }
  const parent = path.dirname(directory);
  return { directory, parent: parent === directory ? undefined : parent, entries: sortDirectoryEntries(entries) };
}

/** The rows a listing shows: folders for both purposes, files only for `file`, filtered by `f`. */
export function pickerEntries(listing: DirectoryListing, purpose: PickerPurpose, showAllFiles: boolean): readonly DirectoryEntry[] {
  return listing.entries.filter(entry => {
    if (entry.kind === "directory") return true;
    if (purpose === "directory") return false;
    return showAllFiles || isProfileFileName(entry.name);
  });
}

export type ExportFileNameOutcome =
  | { readonly kind: "ok"; readonly fileName: string; readonly appendedExtension: boolean }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Validate a typed file name and give it a JSON extension when it has none.
 * Separators and the dot directories are refused so the name stays inside the chosen folder.
 */
export function resolveExportFileName(input: string): ExportFileNameOutcome {
  if (input === "") return { kind: "invalid", message: "Enter a file name." };
  if (input === "." || input === "..") return { kind: "invalid", message: "A file name cannot be . or .." };
  if (input.includes("/") || input.includes("\\")) return { kind: "invalid", message: "A file name cannot contain / or \\." };
  if (path.extname(input) === "") return { kind: "ok", fileName: `${input}${PROFILE_EXTENSION}`, appendedExtension: true };
  return { kind: "ok", fileName: input, appendedExtension: false };
}

/** The full destination path, shown live in the name editor and in the confirmation. */
export function exportDestination(directory: string, fileName: string): string {
  return path.join(directory, fileName);
}

/** A note when the name keeps an extension other than `.json`; `undefined` when nothing needs explaining. */
export function fileNameNotice(fileName: string): string | undefined {
  const extension = path.extname(fileName);
  if (extension === "" || extension.toLowerCase() === PROFILE_EXTENSION) return undefined;
  return `Keeping the ${extension} extension; import lists ${PROFILE_EXTENSION} files by default; press f to show all files.`;
}

export async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
