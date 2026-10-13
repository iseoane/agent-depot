import path from "node:path";
import { Text, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickerEntries, readDirectoryListing, PROFILE_EXTENSION, type DirectoryListing, type DirectoryEntry, type PickerPurpose, type PickerSelection } from "./file-picker-model.js";
import { useKeys } from "./keys.js";
import { moveCursor } from "./mode-keys.js";
import { BorderPanel } from "./panel-parts.js";
import { clipText, wrapText } from "./text-wrap.js";
import { theme } from "./theme.js";
import { useMirrored, useMounted } from "./view-state.js";
import { computeWindow, useListHeight } from "./window.js";

/** Explicit picker state: a read is in flight, a listing is shown, or the read failed recoverably. */
type PickerState =
  | { readonly status: "loading"; readonly directory: string }
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
  const [state, setState] = useState<PickerState>({ status: "loading", directory: startDirectory });
  const [cursor, cursorRef, cursorTo] = useMirrored(0);
  const [showAllFiles, showAllFilesRef, setShowAllFiles] = useMirrored(false);
  const [showFullPath, setShowFullPath] = useState(false);
  const requestId = useRef(0);
  const mounted = useMounted();
  const { columns } = useWindowSize();
  const panelWidth = Math.max((columns || 80) - 4, 1);

  const navigate = useCallback((directory: string) => {
    const id = ++requestId.current;
    cursorTo(0);
    setState({ status: "loading", directory });
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
    if (showFullPath) {
      if (input === "p") setShowFullPath(false);
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
    if (input === "p") { setShowFullPath(true); return; }
    const next = moveCursor(cursorRef.current, rows.length, input, key);
    if (next !== undefined) { cursorTo(Math.max(next, 0)); return; }
    if (key.return) choose(rows[Math.min(cursorRef.current, rows.length - 1)]);
  });

  const directory = state.directory;
  const wrappedDirectory = wrapText(`Directory: ${directory}`, panelWidth);
  const directoryLines = showFullPath || wrappedDirectory.length <= 3
    ? wrappedDirectory
    : [wrappedDirectory[0]!, ...wrapText(`… ${wrappedDirectory.length - 2} lines · press p for full path`, panelWidth), wrappedDirectory.at(-1)!];
  const ordinaryFooterLines = (purpose === "directory"
    ? ["j/k move · Enter open/use · ←", "parent · p full path · Esc back"]
    : ["j/k move · Enter open · ← parent", `f ${showAllFiles ? "json only" : "all files"} · p full path · Esc back`])
    .flatMap(line => wrapText(line, panelWidth));
  const noticeLines = notice === undefined ? [] : wrapText(notice, panelWidth);
  const filterNoteLines = !showFullPath && purpose === "file" && state.status === "ready" && !showAllFiles
    ? wrapText(`Showing ${PROFILE_EXTENSION} only · f shows all files`, panelWidth)
    : [];
  const statusLineCount = !showFullPath && (state.status === "loading" || state.status === "error" || (state.status === "ready" && rows.length === 0)) ? 1 : 0;
  const visibleNoticeLines = showFullPath ? [] : noticeLines;
  const footerLines = showFullPath ? wrapText("p hide path · Esc back", panelWidth) : ordinaryFooterLines;
  const reservesWindowIndicator = !showFullPath && rows.length > 0 && listHeight === undefined ? 1 : 0;
  const reserved = 3 + directoryLines.length + statusLineCount + filterNoteLines.length + visibleNoticeLines.length + footerLines.length + reservesWindowIndicator;
  const available = useListHeight(listHeight, reserved, 1);
  const height = rows.length > available && listHeight !== undefined ? Math.max(available - 1, 1) : available;
  const window = computeWindow(rows.length, cursor, height);
  const listedRows = showFullPath ? [] : rows.slice(window.start, window.end);

  return (
    <BorderPanel title={purpose === "directory" ? "Choose export folder" : "Choose import file"}>
      {directoryLines.map((line, index) => <Text key={index} color={theme.value}>{line}</Text>)}
      {!showFullPath && state.status === "loading" ? <Text color={theme.muted}>Loading…</Text> : null}
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
      {!showFullPath && window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
    </BorderPanel>
  );
}
