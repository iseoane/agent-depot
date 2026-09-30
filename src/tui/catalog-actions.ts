import { PROJECT_HOSTS, type ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type {
  InstallScope,
  PreparedInstall,
} from "./catalog-installs.js";
import type { ManageMode } from "./manage-actions.js";

/** Host choices in checklist order; labels use the project's host identifiers. */
export const HOST_CHOICES: readonly ProjectHost[] = PROJECT_HOSTS;
export const SCOPE_CHOICES: readonly InstallScope[] = ["project", "user-global"];

/** Interaction mode of the Catalog actions; anything but `browse` captures keys so global keys such as q are suspended. */
export type ActionMode =
  | { readonly kind: "browse" }
  | { readonly kind: "host"; readonly skill: SkillCandidate; readonly cursor: number; readonly selected: readonly ProjectHost[] }
  | { readonly kind: "scope"; readonly skill: SkillCandidate; readonly hosts: readonly ProjectHost[] }
  | { readonly kind: "version"; readonly skill: SkillCandidate; readonly hosts: readonly ProjectHost[]; readonly scope: InstallScope }
  | {
      readonly kind: "fixed";
      readonly skill: SkillCandidate;
      readonly hosts: readonly ProjectHost[];
      readonly scope: InstallScope;
      readonly value: string;
    }
  | { readonly kind: "confirm-install"; readonly skill: SkillCandidate; readonly prepared: PreparedInstall }
  | { readonly kind: "confirm-exposure"; readonly skill: SkillCandidate; readonly prepared: PreparedInstall }
  /** `i` on a Skill already installed user-global: add hosts to it or install anew. */
  | { readonly kind: "installed-choice"; readonly skill: SkillCandidate; readonly missing: readonly ProjectHost[] }
  | ManageMode;

export const BROWSE: ActionMode = { kind: "browse" };
