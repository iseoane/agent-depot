import path from "node:path";
import { Text, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickerEntries, readDirectoryListing, PROFILE_EXTENSION, type DirectoryListing, type DirectoryEntry, type PickerPurpose, type PickerSelection } from "./file-picker-model.js";
import { useKeys } from "./keys.js";
import { moveCursor, movePreviewCursor } from "./mode-keys.js";
import { BorderPanel, Working } from "./panel-parts.js";
import { clipText, fitLines, wrapText } from "./text-wrap.js";
import { theme } from "./theme.js";
import { useMirrored, useMounted } from "./view-state.js";
import { computeWindow, useListHeight } from "./window.js";

/** Explicit picker state: a read is in flight, a listing is shown, or the read failed recoverably. */
type PickerState =
  | { readonly status: "loading"; readonly directory: string; readonly startedAt: number }
  | { readonly status: "ready"; readonly directory: string; readonly parent: string | undefined; readonly entries: readonly DirectoryEntry[] }
  | { readonly status: "error"; readonly directory: string; readonly message: string };

type PickerRow =
  | { readonly kind: "use-folder" }
  | { readonly kind: "parent" }
  | { readonly kind: "entry"; readonly entry: DirectoryEntry };

export interface FilePickerProps {
  readonly purpose: PickerPurpose;
  readonly startDirectory: string;
  readonly notice?: string;
  readonly onCancel: () => void;
  readonly onChoose: (selection: PickerSelection) => void;
  readonly listHeight?: number;
  readonly readDirectory?: (directory: string) => Promise<DirectoryListing>;
}

/**
 * A picker callback changes the enclosing view's stage. Defer it so the view's own key
 * handler, which runs in the same event, still sees the picker stage and ignores the key.
 */
function settle(action: () => void): void {
  queueMicrotask(action);
}

/**
 * A keyboard-only directory and file browser. It owns its keys while mounted, so the
 * enclosing view must ignore its own bindings in the picker's stages. Each read carries a
 * request generation, so a slow listing never overwrites a newer directory or an unmount.
 */
export function FilePicker({ purpose, startDirectory, notice, onCancel, onChoose, listHeight, readDirectory = readDirectoryListing }: FilePickerProps) {
  const [state, setState] = useState<PickerState>(() => ({ status: "loading", directory: startDirectory, startedAt: Date.now() }));
  const [cursor, cursorRef, cursorTo] = useMirrored(0);
  const [showAllFiles, showAllFilesRef, setShowAllFiles] = useMirrored(false);
  const [showFullPath, showFullPathRef, setShowFullPath] = useMirrored(false);
  const [pathCursor, pathCursorRef, pathCursorTo] = useMirrored(0);
  // The page size of the full path view, which the key handler needs before the render computes it.
  const pathPageRef = useRef(1);
  const requestId = useRef(0);
  const pathLineCount = useRef(1);
  const mounted = useMounted();
  const { columns } = useWindowSize();
  const panelWidth = Math.max((columns || 80) - 4, 1);

  const navigate = useCallback((directory: string) => {
    const id = ++requestId.current;
    cursorTo(0);
    setState({ status: "loading", directory, startedAt: Date.now() });
    void readDirectory(directory).then(
      listing => {
        if (!mounted.current || requestId.current !== id) return;
        setState({ status: "ready", directory: listing.directory, parent: listing.parent, entries: listing.entries });
      },
      (error: unknown) => {
        if (!mounted.current || requestId.current !== id) return;
        setState({ status: "error", directory, message: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [cursorTo, mounted, readDirectory]);

  useEffect(() => { navigate(startDirectory); }, [navigate, startDirectory]);

  const entries = state.status === "ready" ? pickerEntries(state, purpose, showAllFiles) : [];
  const rows = useMemo<readonly PickerRow[]>(() => {
    const parent: PickerRow[] = state.status === "ready" && state.parent !== undefined ? [{ kind: "parent" }] : [];
    const listing: PickerRow[] = entries.map(entry => ({ kind: "entry", entry }));
    const useFolder: PickerRow[] = state.status === "ready" && purpose === "directory" ? [{ kind: "use-folder" }] : [];
    return [...useFolder, ...parent, ...listing];
  }, [entries, purpose, state]);

  const choose = (row: PickerRow | undefined) => {
    if (!row || state.status !== "ready") return;
    if (row.kind === "use-folder") { settle(() => onChoose({ kind: "directory", directory: state.directory })); return; }
    if (row.kind === "parent") { if (state.parent !== undefined) navigate(state.parent); return; }
    const target = path.join(state.directory, row.entry.name);
    if (row.entry.kind === "directory") navigate(target);
    else settle(() => onChoose({ kind: "file", file: target, directory: state.directory }));
  };

  useKeys((input, key) => {
    if (key.escape) { settle(onCancel); return; }
    if (showFullPathRef.current) {
      if (input === "p") setShowFullPath(false);
      else {
        const next = movePreviewCursor(pathCursorRef.current, pathLineCount.current, input, key, pathPageRef.current);
        if (next !== undefined) pathCursorTo(next);
      }
      return;
    }
    if (state.status !== "ready") {
      const fallbackParent = path.dirname(state.directory);
      if ((key.backspace || key.leftArrow) && fallbackParent !== state.directory) navigate(fallbackParent);
      return;
    }
    if (key.backspace || key.leftArrow) {
      if (state.parent !== undefined) navigate(state.parent);
      return;
    }
    if (input === "f" && purpose === "file") {
      setShowAllFiles(!showAllFilesRef.current);
      cursorTo(0);
      return;
    }
    if (input === "p") { pathCursorTo(0); setShowFullPath(true); return; }
    const next = moveCursor(cursorRef.current, rows.length, input, key);
    if (next !== undefined) { cursorTo(Math.max(next, 0)); return; }
    if (key.return) choose(rows[Math.min(cursorRef.current, rows.length - 1)]);
  });

  const directory = state.directory;
  const wrappedDirectory = wrapText(`Directory: ${directory}`, panelWidth);
  const ordinaryFooter = purpose === "directory"
    ? ["j/k move · Enter open/use · ←", "parent · p full path · Esc back"]
    : ["j/k move · Enter open · ← parent", `f ${showAllFiles ? "json only" : "all files"} · p full path · Esc back`];
  const noticeLines = notice === undefined ? [] : wrapText(notice, panelWidth);
  const statusLineCount = !showFullPath && (state.status === "loading" || state.status === "error" || (state.status === "ready" && rows.length === 0)) ? 1 : 0;
  const listRowsNeeded = rows.length > 0 ? 1 : 0;

  // The roomy layout collapses a long path to three rows and wraps the key hints; the compact one keeps a
  // folder list on screen when that roomy chrome alone would fill a short terminal.
  const roomyDirectoryLines = wrappedDirectory.length <= 3
    ? wrappedDirectory
    : [wrappedDirectory[0]!, ...wrapText(`… ${wrappedDirectory.length - 2} lines · press p for full path`, panelWidth), wrappedDirectory.at(-1)!];
  const roomyFooterLines = ordinaryFooter.flatMap(line => wrapText(line, panelWidth));
  const filterNote = purpose === "file" && state.status === "ready" && !showAllFiles
    ? `Showing ${PROFILE_EXTENSION} only · f shows all files`
    : undefined;
  const roomyFilterNoteLines = filterNote === undefined ? [] : wrapText(filterNote, panelWidth);
  // The compact legend keeps the keys a user would not guess (the filter, the full path, going up).
  const compactFooter = purpose === "directory" ? "← parent · p full path · Esc back"
    : `f ${showAllFiles ? "json only" : "all files"} · p full path · Esc back`;
  const roomyReserved = 3 + roomyDirectoryLines.length + statusLineCount + roomyFilterNoteLines.length + noticeLines.length
    + roomyFooterLines.length + (rows.length > 0 && listHeight === undefined ? 1 : 0);
  const roomyHeight = useListHeight(listHeight, roomyReserved, 0);
  const compact = !showFullPath && listHeight === undefined && roomyHeight < listRowsNeeded;

  const directoryLines = compact ? [clipText(`Directory: ${directory}`, panelWidth)] : roomyDirectoryLines;
  const footerLines = showFullPath ? wrapText("j/k scroll · p hide path · Esc back", panelWidth)
    : compact ? [clipText(compactFooter, panelWidth)] : roomyFooterLines;
  const filterNoteLines = showFullPath ? [] : compact ? (filterNote === undefined ? [] : [clipText(filterNote, panelWidth)]) : roomyFilterNoteLines;
  const visibleNoticeLines = showFullPath ? [] : compact ? fitLines(noticeLines, 2, panelWidth) : noticeLines;
  const reservesWindowIndicator = !showFullPath && rows.length > 0 && listHeight === undefined ? 1 : 0;
  const reserved = 3 + directoryLines.length + statusLineCount + filterNoteLines.length + visibleNoticeLines.length + footerLines.length + reservesWindowIndicator;
  const available = useListHeight(listHeight, reserved, 1);
  const height = rows.length > available && listHeight !== undefined ? Math.max(available - 1, 1) : available;
  const window = computeWindow(rows.length, cursor, height);
  const listedRows = showFullPath ? [] : rows.slice(window.start, window.end);

  // The full path view pages the wrapped path, so a path longer than the terminal is still readable.
  const pathAvailable = useListHeight(listHeight, 3 + footerLines.length, 1);
  const pathHeight = wrappedDirectory.length > pathAvailable ? Math.max(pathAvailable - 1, 1) : pathAvailable;
  const pathWindow = computeWindow(wrappedDirectory.length, pathCursor, pathHeight);
  pathLineCount.current = wrappedDirectory.length;
  pathPageRef.current = pathHeight;
  const shownDirectoryLines = showFullPath ? wrappedDirectory.slice(pathWindow.start, pathWindow.end) : directoryLines;

  return (
    <BorderPanel title={purpose === "directory" ? "Choose export folder" : "Choose import file"}>
      {shownDirectoryLines.map((line, index) => <Text key={index} color={theme.value}>{line}</Text>)}
      {!showFullPath && state.status === "loading" ? <Working label="Loading folder…" since={state.startedAt} /> : null}
      {!showFullPath && state.status === "error" ? <Text color={theme.error}>Error: {clipText(state.message, panelWidth)}</Text> : null}
      {!showFullPath && state.status === "ready" && rows.length === 0 ? <Text color={theme.muted}>Empty folder</Text> : null}
      {filterNoteLines.map((line, index) => <Text key={`filter-${index}`} color={theme.muted}>{line}</Text>)}
      {listedRows.map((row, position) => {
        const index = window.start + position;
        const marker = index === cursor ? "> " : "  ";
        const label = row.kind === "use-folder" ? `Use this folder: ${directory}`
          : row.kind === "parent" ? ".. (parent folder)"
            : row.entry.kind === "directory" ? `${row.entry.name}/` : row.entry.name;
        return <Text key={index}><Text color={theme.field}>{marker}</Text><Text color={theme.value}>{clipText(label, Math.max(panelWidth - 2, 1))}</Text></Text>;
      })}
      {visibleNoticeLines.map((line, index) => <Text key={`notice-${index}`} color={theme.warning}>{line}</Text>)}
      {footerLines.map((line, index) => <Text key={`footer-${index}`} color={theme.legend}>{line}</Text>)}
      {showFullPath ? (pathWindow.indicator ? <Text color={theme.muted}>{pathWindow.indicator}</Text> : null)
        : window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
    </BorderPanel>
  );
}
