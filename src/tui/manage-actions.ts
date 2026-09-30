import type { Key } from "ink";

import type { ProjectHost } from "../project-manifest.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type { SourceOperations } from "../sources.js";
import {
  globalRecord,
  missingHosts,
  prepareHostAddition,
  prepareHostRemoval,
  prepareUninstall,
  runHostAddition,
  runHostRemoval,
  runUninstall,
  type InstalledSkills,
  type PreparedHostAddition,
  type PreparedHostRemoval,
  type UninstallPreparation,
} from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { handleUnmanagedKey, UNMANAGED_KINDS, type UnmanagedMode } from "./unmanaged-actions.js";

/**
 * Interaction modes for managing an installed user-global Skill (uninstall and
 * host changes), run from the Installations view. Anything but `browse`
 * captures keys.
 */
export type ManageMode =
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
  | {
      readonly kind: "confirm-uninstall";
      readonly skill: SkillCandidate;
      readonly prepared: Extract<UninstallPreparation, { kind: "ready" }>;
    }
  | UnmanagedMode
  | { readonly kind: "busy"; readonly label: string };

const MANAGE_KINDS: ReadonlySet<string> = new Set<ManageMode["kind"]>([
  "remove-scope",
  "hosts-add",
  "hosts-remove",
  "confirm-host-add",
  "confirm-host-exposure",
  "confirm-host-remove",
  "confirm-uninstall",
  ...UNMANAGED_KINDS,
  "busy",
]);

function isManageMode(mode: { readonly kind: string }): mode is ManageMode {
  return MANAGE_KINDS.has(mode.kind);
}

export interface ManageMessage {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** What the flow needs from the hosting view; the view owns its own mode state and reloading. */
export interface ManageContext {
  readonly operations: SourceOperations;
  readonly env: TuiEnvironment;
  readonly installed: InstalledSkills;
  setMode(mode: ManageMode): void;
  /** Returns the view to browsing. */
  browse(): void;
  setMessage(message: ManageMessage | undefined): void;
  isMounted(): boolean;
  /** Reloads the view's data first so the result and the refreshed rows appear together, then browses. */
  finish(result: ManageMessage): Promise<void>;
}

const UNINSTALL_REFUSALS = {
  unsupported: "Uninstall is not supported by the configured operations",
  "not-installed": "Skill is not installed",
  "project-only": "Project uninstall is not supported",
} as const;

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function cancel(context: ManageContext, text: string): void {
  context.setMessage({ kind: "ok", text });
  context.browse();
}

/** `u`: one host goes straight to full removal; several ask whether to remove all or choose. */
export function startUninstall(context: ManageContext, skill: SkillCandidate): void {
  const record = globalRecord(skill, context.installed);
  if (record && record.hosts.length > 1) context.setMode({ kind: "remove-scope", skill, hosts: record.hosts });
  else void startFullUninstall(context, skill);
}

async function startFullUninstall(context: ManageContext, skill: SkillCandidate): Promise<void> {
  context.setMode({ kind: "busy", label: `Preparing uninstall of ${skill.name}...` });
  try {
    const prepared = await prepareUninstall(context.operations, context.env, skill, context.installed);
    if (!context.isMounted()) return;
    if (prepared.kind === "ready") {
      context.setMode({ kind: "confirm-uninstall", skill, prepared });
      return;
    }
    context.setMessage({ kind: "error", text: UNINSTALL_REFUSALS[prepared.kind] });
  } catch (error) {
    if (!context.isMounted()) return;
    context.setMessage({ kind: "error", text: errorText(error) });
  }
  context.browse();
}

/** Opens the host checklist for the hosts the installed Skill does not serve yet. */
export function startHostAddition(context: ManageContext, skill: SkillCandidate): void {
  const record = globalRecord(skill, context.installed);
  const missing = record ? missingHosts(record) : [];
  if (missing.length === 0) {
    context.setMessage({ kind: "error", text: record ? `${skill.name} already has every host` : "Skill is not installed" });
    return;
  }
  context.setMode({ kind: "hosts-add", skill, choices: missing, cursor: 0, selected: [] });
}

async function startHostChange(context: ManageContext, mode: Extract<ManageMode, { kind: "hosts-add" | "hosts-remove" }>): Promise<void> {
  const { operations, env, installed } = context;
  context.setMode({ kind: "busy", label: `Preparing host change of ${mode.skill.name}...` });
  try {
    if (mode.kind === "hosts-add") {
      const prepared = await prepareHostAddition(operations, env, mode.skill, installed, mode.selected);
      if (!context.isMounted()) return;
      context.setMode({ kind: "confirm-host-add", skill: mode.skill, prepared });
    } else {
      const prepared = await prepareHostRemoval(operations, env, mode.skill, installed, mode.selected);
      if (!context.isMounted()) return;
      context.setMode({ kind: "confirm-host-remove", skill: mode.skill, prepared });
    }
  } catch (error) {
    if (!context.isMounted()) return;
    context.setMessage({ kind: "error", text: errorText(error) });
    context.browse();
  }
}

/** Runs a confirmed step in the busy mode and finishes with its outcome. */
async function execute(context: ManageContext, label: string, action: () => Promise<string>): Promise<void> {
  context.setMode({ kind: "busy", label });
  let result: ManageMessage;
  try {
    result = { kind: "ok", text: await action() };
  } catch (error) {
    result = { kind: "error", text: errorText(error) };
  }
  await context.finish(result);
}

/**
 * Handles a key in one of the manage modes. Returns false when the mode is not
 * a manage mode, so the host view can handle its own modes.
 */
export function handleManageKey(context: ManageContext, mode: { readonly kind: string }, input: string, key: Key): boolean {
  if (!isManageMode(mode)) return false;
  const { operations, env } = context;
  if (handleUnmanagedKey(context, mode, input, key)) return true;
  switch (mode.kind) {
    case "remove-scope":
      if (key.escape) cancel(context, "Uninstall cancelled");
      else if (input === "1") void startFullUninstall(context, mode.skill);
      else if (input === "2") context.setMode({ kind: "hosts-remove", skill: mode.skill, choices: mode.hosts, cursor: 0, selected: [] });
      return true;
    case "hosts-add":
    case "hosts-remove": {
      const toggle = (host: ProjectHost) =>
        mode.choices.filter((candidate) => candidate === host ? !mode.selected.includes(candidate) : mode.selected.includes(candidate));
      const numbered = mode.choices[Number(input) - 1];
      if (key.escape) cancel(context, mode.kind === "hosts-add" ? "Install cancelled" : "Uninstall cancelled");
      else if (key.downArrow || input === "j") context.setMode({ ...mode, cursor: Math.min(mode.cursor + 1, mode.choices.length - 1) });
      else if (key.upArrow || input === "k") context.setMode({ ...mode, cursor: Math.max(mode.cursor - 1, 0) });
      else if (input === " ") context.setMode({ ...mode, selected: toggle(mode.choices[mode.cursor]!) });
      else if (numbered) context.setMode({ ...mode, selected: toggle(numbered) });
      else if (key.return) {
        if (mode.selected.length > 0) void startHostChange(context, mode);
        else context.setMessage({ kind: "error", text: "Select at least one host" });
      }
      return true;
    }
    case "confirm-host-add":
      if (input === "y") context.setMode({ ...mode, kind: "confirm-host-exposure" });
      else if (input === "n" || key.escape) cancel(context, "Install cancelled");
      return true;
    case "confirm-host-exposure":
      if (input === "y") {
        void execute(context, `Changing hosts of ${mode.skill.name}...`, () => runHostAddition(mode.prepared, operations, env));
      } else if (input === "n" || key.escape) cancel(context, "Install cancelled");
      return true;
    case "confirm-host-remove":
      if (input === "y") {
        void execute(context, `Changing hosts of ${mode.skill.name}...`, () => runHostRemoval(mode.prepared, operations, env, mode.skill));
      } else if (input === "n" || key.escape) cancel(context, "Uninstall cancelled");
      return true;
    case "confirm-uninstall":
      if (input === "y") {
        void execute(context, `Removing ${mode.skill.name}...`, async () => {
          await runUninstall(mode.prepared, operations, env);
          return `Removed ${mode.skill.name} (${mode.skill.path})`;
        });
      } else if (input === "n" || key.escape) cancel(context, "Uninstall cancelled");
      return true;
    default:
      return true;
  }
}
