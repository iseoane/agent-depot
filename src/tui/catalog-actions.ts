import { PROJECT_HOSTS, type ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type {
  InstallScope,
  PreparedInstall,
} from "./catalog-installs.js";

/** Host choices in checklist order; labels use the project's host identifiers. */
export const HOST_CHOICES: readonly ProjectHost[] = PROJECT_HOSTS;
export const SCOPE_CHOICES: readonly InstallScope[] = ["project", "user-global"];

/** One Skill of an install batch: prepared, or the reason it could not be prepared (shown, then skipped). */
export interface BatchItem {
  readonly skill: SkillCandidate;
  readonly prepared?: PreparedInstall;
  readonly error?: string;
}

/** `beta` for one Skill, `3 skills` for a batch. */
export function describeSkills(skills: readonly SkillCandidate[]): string {
  return skills.length === 1 ? skills[0]!.name : `${skills.length} skills`;
}

/** Interaction mode of the Catalog actions; anything but `browse` captures keys so global keys such as q are suspended. */
export type ActionMode =
  | { readonly kind: "browse" }
  | { readonly kind: "host"; readonly skills: readonly SkillCandidate[]; readonly cursor: number; readonly selected: readonly ProjectHost[] }
  | { readonly kind: "scope"; readonly skills: readonly SkillCandidate[]; readonly hosts: readonly ProjectHost[] }
  | { readonly kind: "version"; readonly skills: readonly SkillCandidate[]; readonly hosts: readonly ProjectHost[]; readonly scope: InstallScope }
  | {
      readonly kind: "fixed";
      readonly skills: readonly SkillCandidate[];
      readonly hosts: readonly ProjectHost[];
      readonly scope: InstallScope;
      readonly value: string;
    }
  | { readonly kind: "confirm-install"; readonly items: readonly BatchItem[] }
  | { readonly kind: "confirm-exposure"; readonly items: readonly BatchItem[] }
  /** A step is running (refreshing, installing); keys are ignored until it ends. */
  | { readonly kind: "busy"; readonly label: string };

export const BROWSE: ActionMode = { kind: "browse" };
