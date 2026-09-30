import { PROJECT_HOSTS, type ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type {
  InstallScope,
  PreparedHostAddition,
  PreparedHostRemoval,
  PreparedInstall,
  UninstallPreparation,
} from "./catalog-installs.js";

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
  | {
      readonly kind: "confirm-uninstall";
      readonly skill: SkillCandidate;
      readonly prepared: Extract<UninstallPreparation, { kind: "ready" }>;
    }
  /** `i` on a Skill already installed user-global: add hosts to it or install anew. */
  | { readonly kind: "installed-choice"; readonly skill: SkillCandidate; readonly missing: readonly ProjectHost[] }
  /** `u` on an installation with several hosts: remove all of them or choose. */
  | { readonly kind: "remove-scope"; readonly skill: SkillCandidate; readonly hosts: readonly ProjectHost[] }
  | {
      readonly kind: "hosts-add" | "hosts-remove";
      readonly skill: SkillCandidate;
      readonly choices: readonly ProjectHost[];
      readonly cursor: number;
      readonly selected: readonly ProjectHost[];
    }
  | { readonly kind: "confirm-host-add"; readonly skill: SkillCandidate; readonly prepared: PreparedHostAddition }
  | { readonly kind: "confirm-host-exposure"; readonly skill: SkillCandidate; readonly prepared: PreparedHostAddition }
  | { readonly kind: "confirm-host-remove"; readonly skill: SkillCandidate; readonly prepared: PreparedHostRemoval }
  | { readonly kind: "busy"; readonly label: string };

export const BROWSE: ActionMode = { kind: "browse" };

/** Asks the Catalog to highlight a Skill and start the same uninstall or install/host flow as pressing `u` or `i`. */
export interface CatalogFocus {
  readonly sourceId: string;
  readonly path: string;
  readonly action: "install" | "uninstall";
}
