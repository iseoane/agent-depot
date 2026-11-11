import { PROJECT_HOSTS, type ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type { PackageMode } from "./package-actions.js";
import type { PreviewChrome } from "./preview-window.js";
import type { Busy } from "./working-model.js";
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
  | { readonly kind: "confirm-install"; readonly items: readonly BatchItem[]; readonly cursor: number }
  | { readonly kind: "confirm-exposure"; readonly items: readonly BatchItem[] }
  /** A Package bundle action reuses the shared Package modes and preview. */
  | PackageMode
  /** A step is running (refreshing, installing); keys are ignored until it ends. */
  | Busy;

export const BROWSE: ActionMode = { kind: "browse" };

/** What the install confirmation shows, so the key handler and the panel page the same rows. */
export function installPreview(items: readonly BatchItem[]): { readonly lines: readonly string[]; readonly chrome: PreviewChrome } {
  const ready = items.filter((item) => item.prepared !== undefined);
  const single = items.length === 1;
  const name = describeSkills(ready.map((item) => item.skill));
  const lines = [
    ...(ready[0]?.prepared?.projectTarget ?? []),
    ...items.flatMap(({ skill, prepared, error }) =>
      prepared === undefined ? [`Cannot install ${skill.name}: ${error}`] : [...(single ? [] : [skill.name]), ...prepared.preview]),
    ...(ready.some((item) => item.prepared?.runsExternalCommand) ? ["This install runs an external command (see above)."] : []),
  ];
  return { lines, chrome: { title: `Skill install preview · ${ready.length} ready`, action: `Install ${name}`, consequence: `Install ${name}? y/n` } };
}
