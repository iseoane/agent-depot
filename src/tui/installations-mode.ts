import type { ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type { UserGlobalSkillInventoryEntry } from "../user-global-skill-inventory.js";
import type { PreparedAdoption } from "./installations.js";
import type { ManageMode } from "./manage-actions.js";

type Entry = UserGlobalSkillInventoryEntry;

/** Interaction mode of the adoption and manage flows; anything but `browse` captures keys so global keys such as q are suspended. */
export type InstallationsMode =
  | { readonly kind: "browse" }
  | { readonly kind: "pick"; readonly entry: Entry; readonly candidates: readonly SkillCandidate[]; readonly cursor: number }
  | { readonly kind: "host"; readonly entry: Entry; readonly skill: SkillCandidate; readonly cursor: number; readonly selected: readonly ProjectHost[] }
  | { readonly kind: "version"; readonly entry: Entry; readonly skill: SkillCandidate; readonly hosts: readonly ProjectHost[] }
  | { readonly kind: "fixed"; readonly entry: Entry; readonly skill: SkillCandidate; readonly hosts: readonly ProjectHost[]; readonly value: string }
  | { readonly kind: "confirm"; readonly entry: Entry; readonly skill: SkillCandidate; readonly adoption: PreparedAdoption }
  | { readonly kind: "confirm-exposure"; readonly entry: Entry; readonly skill: SkillCandidate; readonly adoption: PreparedAdoption }
  | ManageMode;

export const BROWSE: InstallationsMode = { kind: "browse" };
