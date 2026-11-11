import type { Key } from "ink";

import { collapseOrParent, expandNode, toggleNode, type Expanded } from "./tree.js";
import { toggleGroup } from "./updates-tree.js";
import { answerYesNo, movePreviewCursor } from "./mode-keys.js";
import type { UpdatesListView } from "./updates-model.js";
import type { UpdatesMode } from "./updates-mode.js";
import type { PreparedUpdates, ScopedPath, UpdateScopeFilter, UpdatesData } from "./updates.js";
import { busy } from "./working-model.js";
import { pageStep } from "./window.js";

/** The list, the cursor and the fold as of the latest keystroke. */
export interface UpdatesSnapshot extends UpdatesListView {
  readonly data: UpdatesData | undefined;
  readonly at: number;
}

/** What the Updates keys need from the view; the view owns the state, mirrored in refs. */
export interface UpdatesKeyContext {
  readonly height: number;
  /** The view's clock, so a busy mode starts on the same time base the elapsed time is read from. */
  readonly now: () => number;
  previewMetrics(mode: UpdatesMode): { readonly length: number; readonly pageSize: number };
  previewAtEnd(mode: UpdatesMode): boolean;
  latest(): UpdatesSnapshot;
  checked(): readonly string[];
  setChecked(next: readonly string[]): void;
  setCursor(next: number): void;
  /** The groups the user has expanded; every group starts collapsed. */
  expanded(): Expanded;
  setExpanded(next: Expanded): void;
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

/** Space toggles the highlighted update or every update of the highlighted group, `a` selects them all. */
function selectKey(context: UpdatesKeyContext, snapshot: UpdatesSnapshot, input: string): boolean {
  if (input === " ") {
    const entry = snapshot.entries[snapshot.at];
    if (entry?.kind === "group") context.setChecked(toggleGroup(context.checked(), entry.leafKeys));
    else if (entry?.kind === "update") context.setChecked(toggleGroup(context.checked(), [entry.row.key]));
  } else if (input === "a") context.setChecked(snapshot.updatable.map((row) => row.key));
  else return false;
  return true;
}

/** Moves to the group above the highlighted line, or stays when there is none. */
function selectParent(context: UpdatesKeyContext, snapshot: UpdatesSnapshot, parentId: string | undefined): void {
  const parent = snapshot.entries.findIndex((entry) => entry.kind !== "summary" && entry.kind !== "unknown" && entry.line.node.id === parentId);
  if (parent >= 0) context.setCursor(parent);
}

/** Right/left expand and collapse groups and the "cannot be checked" rows; Enter does the same on a line that is not an update. */
function foldKey(context: UpdatesKeyContext, snapshot: UpdatesSnapshot, key: Key): void {
  const entry = snapshot.entries[snapshot.at];
  if (key.rightArrow) {
    if (entry?.kind === "group") context.setExpanded(expandNode(context.expanded(), entry.line));
    else if (entry?.kind === "summary") context.setShowUnknown(true);
  } else if (key.leftArrow) {
    if (entry?.kind === "group" || entry?.kind === "update") {
      const next = collapseOrParent(context.expanded(), [entry.line], 0);
      context.setExpanded(next.expanded);
      if (next.selectedId !== entry.line.node.id) selectParent(context, snapshot, entry.line.parentId);
    } else if (entry?.kind === "summary" || entry?.kind === "unknown") {
      if (entry.kind === "unknown") context.setCursor(snapshot.entries.findIndex((candidate) => candidate.kind === "summary"));
      context.setShowUnknown(false);
    }
  } else if (key.return) {
    if (entry?.kind === "group") context.setExpanded(toggleNode(context.expanded(), entry.line));
    else if (entry?.kind === "summary") context.setShowUnknown(!context.unknownShown());
    else if (entry?.kind !== "unknown" && snapshot.data) context.startPreview();
  }
}

function handleBrowseKey(context: UpdatesKeyContext, input: string, key: Key): void {
  const snapshot = context.latest();
  if (moveCursorKey(context, snapshot, input, key) || selectKey(context, snapshot, input)) return;
  const scope = SCOPE_KEYS.get(input);
  if (scope !== undefined) context.changeScope(scope);
  else if (input === "r") context.recheck();
  else if (input === "u") context.startPreview();
  else foldKey(context, snapshot, key);
}

function handlePreviewKey(context: UpdatesKeyContext, mode: Extract<UpdatesMode, { kind: "preview" }>, input: string, key: Key): void {
  const metrics = context.previewMetrics(mode);
  const cursor = movePreviewCursor(mode.cursor, metrics.length, input, key, metrics.pageSize);
  if (cursor !== undefined) {
    context.setMode({ ...mode, cursor });
    return;
  }
  if (mode.prepared.applicable.length === 0) {
    if (key.escape || key.return || input === "n") context.cancel();
    return;
  }
  answerYesNo(input, key, () => {
    if (!context.previewAtEnd(mode)) return;
    if (mode.prepared.nonCanonicalPaths.length > 0) context.setMode({ ...mode, kind: "confirm-paths", cursor: 0 });
    else context.apply(mode.prepared, []);
  }, context.cancel);
}

/** Handles a key in the current Updates mode; `busy` ignores keys. */
export function handleUpdatesKey(context: UpdatesKeyContext, mode: UpdatesMode, input: string, key: Key): void {
  switch (mode.kind) {
    case "manual": {
      const metrics = context.previewMetrics(mode);
      const cursor = movePreviewCursor(mode.cursor, metrics.length, input, key, metrics.pageSize);
      if (cursor !== undefined) { context.setMode({ ...mode, cursor }); return; }
      answerYesNo(input, key, () => {
        if (!context.previewAtEnd(mode)) return;
        context.setMode(busy("Checking App version…", mode, context.now));
        mode.answer(true);
      }, () => {
        context.setMode(busy("Continuing updates…", mode, context.now));
        mode.answer(false);
      });
      return;
    }
    case "browse":
      handleBrowseKey(context, input, key);
      return;
    case "preview":
      handlePreviewKey(context, mode, input, key);
      return;
    case "confirm-paths": {
      const metrics = context.previewMetrics(mode);
      const cursor = movePreviewCursor(mode.cursor, metrics.length, input, key, metrics.pageSize);
      if (cursor !== undefined) { context.setMode({ ...mode, cursor }); return; }
      answerYesNo(input, key, () => {
        if (context.previewAtEnd(mode)) context.apply(mode.prepared, mode.prepared.nonCanonicalPaths);
      }, context.cancel);
      return;
    }
    default:
      return;
  }
}
