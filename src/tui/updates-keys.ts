import type { Key } from "ink";

import { answerYesNo } from "./mode-keys.js";
import type { UpdatesListView } from "./updates-model.js";
import type { UpdatesMode } from "./updates-mode.js";
import type { PreparedUpdates, ScopedPath, UpdateScopeFilter, UpdatesData } from "./updates.js";
import { pageStep } from "./window.js";

/** The list, the cursor and the fold as of the latest keystroke. */
export interface UpdatesSnapshot extends UpdatesListView {
  readonly data: UpdatesData | undefined;
  readonly at: number;
}

/** What the Updates keys need from the view; the view owns the state, mirrored in refs. */
export interface UpdatesKeyContext {
  readonly height: number;
  latest(): UpdatesSnapshot;
  checked(): readonly string[];
  setChecked(next: readonly string[]): void;
  setCursor(next: number): void;
  unknownShown(): boolean;
  setShowUnknown(next: boolean): void;
  changeScope(next: UpdateScopeFilter): void;
  /** `r`: clears the message and the fold, then checks again with a refresh. */
  recheck(): void;
  startPreview(): void;
  setMode(mode: UpdatesMode): void;
  cancel(): void;
  apply(prepared: PreparedUpdates, confirmedPaths: readonly ScopedPath[]): void;
}

const SCOPE_KEYS: ReadonlyMap<string, UpdateScopeFilter> = new Map([["t", "all"], ["p", "project"], ["g", "user-global"]]);

/** Moves the cursor with the arrows, j/k and paging; returns whether the key was one of them. */
function moveCursorKey(context: UpdatesKeyContext, snapshot: UpdatesSnapshot, input: string, key: Key): boolean {
  const last = Math.max(snapshot.entries.length - 1, 0);
  const { at } = snapshot;
  if (key.downArrow || input === "j") context.setCursor(Math.min(at + 1, last));
  else if (key.upArrow || input === "k") context.setCursor(Math.max(at - 1, 0));
  else if (key.pageDown) context.setCursor(Math.min(at + pageStep(context.height), last));
  else if (key.pageUp) context.setCursor(Math.max(at - pageStep(context.height), 0));
  else return false;
  return true;
}

/** Space toggles the highlighted update, `a` selects them all. */
function selectKey(context: UpdatesKeyContext, snapshot: UpdatesSnapshot, input: string): boolean {
  if (input === " ") {
    const entry = snapshot.entries[snapshot.at];
    if (entry?.kind !== "update") return true;
    const checked = context.checked();
    context.setChecked(checked.includes(entry.row.key) ? checked.filter((id) => id !== entry.row.key) : [...checked, entry.row.key]);
  } else if (input === "a") context.setChecked(snapshot.updatable.map((row) => row.key));
  else return false;
  return true;
}

/** Right/left unfold and fold the "cannot be checked" rows; Enter toggles the fold or previews the selection. */
function foldKey(context: UpdatesKeyContext, snapshot: UpdatesSnapshot, key: Key): void {
  const entry = snapshot.entries[snapshot.at];
  if (key.rightArrow) {
    if (entry?.kind === "summary") context.setShowUnknown(true);
  } else if (key.leftArrow) {
    if (entry?.kind === "unknown") context.setCursor(snapshot.updatable.length);
    if (entry?.kind === "summary" || entry?.kind === "unknown") context.setShowUnknown(false);
  } else if (key.return) {
    if (entry?.kind === "summary") context.setShowUnknown(!context.unknownShown());
    else if (entry?.kind !== "unknown" && snapshot.data) context.startPreview();
  }
}

function handleBrowseKey(context: UpdatesKeyContext, input: string, key: Key): void {
  const snapshot = context.latest();
  if (moveCursorKey(context, snapshot, input, key) || selectKey(context, snapshot, input)) return;
  const scope = SCOPE_KEYS.get(input);
  if (scope !== undefined) context.changeScope(scope);
  else if (input === "r") context.recheck();
  else foldKey(context, snapshot, key);
}

function handlePreviewKey(context: UpdatesKeyContext, mode: Extract<UpdatesMode, { kind: "preview" }>, input: string, key: Key): void {
  if (mode.prepared.applicable.length === 0) {
    if (key.escape || key.return || input === "n") context.cancel();
    return;
  }
  answerYesNo(input, key, () => {
    if (mode.prepared.nonCanonicalPaths.length > 0) context.setMode({ ...mode, kind: "confirm-paths" });
    else context.apply(mode.prepared, []);
  }, context.cancel);
}

/** Handles a key in the current Updates mode; `busy` ignores keys. */
export function handleUpdatesKey(context: UpdatesKeyContext, mode: UpdatesMode, input: string, key: Key): void {
  switch (mode.kind) {
    case "manual":
      answerYesNo(input, key, () => {
        context.setMode({ kind: "busy", label: "Checking App version..." });
        mode.answer(true);
      }, () => {
        context.setMode({ kind: "busy", label: "Continuing updates..." });
        mode.answer(false);
      });
      return;
    case "browse":
      handleBrowseKey(context, input, key);
      return;
    case "preview":
      handlePreviewKey(context, mode, input, key);
      return;
    case "confirm-paths":
      answerYesNo(input, key, () => context.apply(mode.prepared, mode.prepared.nonCanonicalPaths), context.cancel);
      return;
    default:
      return;
  }
}
