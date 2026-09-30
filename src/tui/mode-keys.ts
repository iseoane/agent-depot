import type { Key } from "ink";

import type { ProjectHost } from "../project-manifest.js";
import { isValidFixedVersion } from "../skill-install.js";

/** The cursor after a down/up key (arrows or j/k), or undefined when the key does not move it. */
export function moveCursor(cursor: number, length: number, input: string, key: Key): number | undefined {
  if (key.downArrow || input === "j") return Math.min(cursor + 1, length - 1);
  if (key.upArrow || input === "k") return Math.max(cursor - 1, 0);
  return undefined;
}

/** `selected` with `choice` flipped, always in the order of `choices`. */
export function toggleChoice<T>(choices: readonly T[], selected: readonly T[], choice: T): T[] {
  return choices.filter((candidate) => candidate === choice ? !selected.includes(candidate) : selected.includes(candidate));
}

export interface ChecklistState {
  readonly cursor: number;
  readonly selected: readonly ProjectHost[];
}

/** What a key did to a host checklist; the caller owns its own texts and what happens next. */
export type ChecklistOutcome =
  | { readonly kind: "cancel" }
  | { readonly kind: "update"; readonly state: ChecklistState }
  | { readonly kind: "submit"; readonly selected: readonly ProjectHost[] }
  /** Enter with nothing selected. */
  | { readonly kind: "empty" }
  | { readonly kind: "ignore" };

/**
 * Keys of a host checklist: Esc cancels, j/k or arrows move, space toggles the
 * cursor row, a digit toggles that row, Enter submits a non-empty selection.
 */
export function hostChecklistKey(
  state: ChecklistState,
  choices: readonly ProjectHost[],
  input: string,
  key: Key,
): ChecklistOutcome {
  if (key.escape) return { kind: "cancel" };
  const cursor = moveCursor(state.cursor, choices.length, input, key);
  if (cursor !== undefined) return { kind: "update", state: { ...state, cursor } };
  const flipped = input === " " ? choices[state.cursor] : choices[Number(input) - 1];
  if (input === " " || flipped !== undefined) {
    return { kind: "update", state: { ...state, selected: toggleChoice(choices, state.selected, flipped!) } };
  }
  if (key.return) return state.selected.length > 0 ? { kind: "submit", selected: state.selected } : { kind: "empty" };
  return { kind: "ignore" };
}

/** The y/n confirmation keys: `y` confirms, `n` or Esc declines, anything else is ignored. */
export function answerYesNo(input: string, key: Key, onYes: () => void, onNo: () => void): void {
  if (input === "y") onYes();
  else if (input === "n" || key.escape) onNo();
}

/** What a key did to the fixed-version text input. */
export type VersionInputOutcome =
  | { readonly kind: "cancel" }
  | { readonly kind: "submit" }
  | { readonly kind: "edit"; readonly value: string }
  | { readonly kind: "ignore" };

/** Esc cancels, Enter submits a valid version, backspace deletes, any other plain key is typed. */
export function versionInputKey(value: string, input: string, key: Key): VersionInputOutcome {
  if (key.escape) return { kind: "cancel" };
  if (key.return) return isValidFixedVersion(value) ? { kind: "submit" } : { kind: "ignore" };
  if (key.backspace || key.delete) return { kind: "edit", value: value.slice(0, -1) };
  if (input !== "" && !key.ctrl && !key.meta) return { kind: "edit", value: value + input };
  return { kind: "ignore" };
}
