import type { SkillCandidate } from "../skill-discovery.js";

/** Filter state of the Catalog view; only `editing` captures keys so global keys such as q are suspended. */
export interface FilterState {
  readonly editing: boolean;
  readonly query: string;
}

export type FilterEvent =
  | { readonly type: "open" }
  | { readonly type: "edit"; readonly query: string }
  | { readonly type: "keep" }
  | { readonly type: "clear" };

export const initialFilter: FilterState = { editing: false, query: "" };

export function filterReducer(state: FilterState, event: FilterEvent): FilterState {
  switch (event.type) {
    case "open":
      return { ...state, editing: true };
    case "edit":
      return state.editing ? { editing: true, query: event.query } : state;
    case "keep":
      return { ...state, editing: false };
    case "clear":
      return initialFilter;
  }
}

/** Case-insensitive match on name and description. */
export function filterSkills(skills: readonly SkillCandidate[], query: string): readonly SkillCandidate[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return skills;
  return skills.filter(
    (skill) => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
  );
}
