import type { Key } from "ink";

import { APP_KINDS, type AppMode } from "./app-actions.js";
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
  UNINSTALL_REFUSALS,
  type InstalledSkills,
  type PreparedHostAddition,
  type PreparedHostRemoval,
  type UninstallPreparation,
} from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { errorText } from "./batch.js";
import { BULK_KINDS, handleBulkKey, type BulkMode } from "./bulk-actions.js";
import { answerYesNo, applyChecklistOutcome, hostChecklistKey } from "./mode-keys.js";
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
  | AppMode
  | UnmanagedMode
  | BulkMode
  | { readonly kind: "busy"; readonly label: string };

const MANAGE_KINDS: ReadonlySet<string> = new Set<ManageMode["kind"]>([
  "remove-scope",
  "hosts-add",
  "hosts-remove",
  "confirm-host-add",
  "confirm-host-exposure",
  "confirm-host-remove",
  "confirm-uninstall",
  ...APP_KINDS,
  ...UNMANAGED_KINDS,
  ...BULK_KINDS,
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
  /** Drops the marks of the items a bulk action applied. */
  unmark(ids: readonly string[]): void;
}

export { errorText };

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

type ModeOf<K extends ManageMode["kind"]> = Extract<ManageMode, { kind: K }>;

function handleHostChecklistKey(context: ManageContext, mode: ModeOf<"hosts-add" | "hosts-remove">, input: string, key: Key): void {
  applyChecklistOutcome(hostChecklistKey(mode, mode.choices, input, key), {
    cancel: () => cancel(context, mode.kind === "hosts-add" ? "Install cancelled" : "Uninstall cancelled"),
    update: (state) => context.setMode({ ...mode, ...state }),
    submit: () => void startHostChange(context, mode),
    setMessage: context.setMessage,
  });
}

function handleRemoveScopeKey(context: ManageContext, mode: ModeOf<"remove-scope">, input: string, key: Key): void {
  if (key.escape) cancel(context, "Uninstall cancelled");
  else if (input === "1") void startFullUninstall(context, mode.skill);
  else if (input === "2") context.setMode({ kind: "hosts-remove", skill: mode.skill, choices: mode.hosts, cursor: 0, selected: [] });
}

/** Keys of the confirmation modes: `y` runs the step (or asks for exposure consent first), `n`/Esc cancels. */
function handleConfirmKey(context: ManageContext, mode: ModeOf<"confirm-host-add" | "confirm-host-exposure" | "confirm-host-remove" | "confirm-uninstall">, input: string, key: Key): void {
  const { operations, env } = context;
  const cancelWith = (text: string) => () => cancel(context, text);
  switch (mode.kind) {
    case "confirm-host-add":
      answerYesNo(input, key, () => context.setMode({ ...mode, kind: "confirm-host-exposure" }), cancelWith("Install cancelled"));
      return;
    case "confirm-host-exposure":
      answerYesNo(input, key, () => {
        void execute(context, `Changing hosts of ${mode.skill.name}...`, () => runHostAddition(mode.prepared, operations, env));
      }, cancelWith("Install cancelled"));
      return;
    case "confirm-host-remove":
      answerYesNo(input, key, () => {
        void execute(context, `Changing hosts of ${mode.skill.name}...`, () => runHostRemoval(mode.prepared, operations, env, mode.skill));
      }, cancelWith("Uninstall cancelled"));
      return;
    case "confirm-uninstall":
      answerYesNo(input, key, () => {
        void execute(context, `Removing ${mode.skill.name}...`, async () => {
          await runUninstall(mode.prepared, operations, env);
          return `Removed ${mode.skill.name} (${mode.skill.path})`;
        });
      }, cancelWith("Uninstall cancelled"));
      return;
  }
}

/**
 * Handles a key in one of the manage modes. Returns false when the mode is not
 * a manage mode, so the host view can handle its own modes.
 */
export function handleManageKey(context: ManageContext, mode: { readonly kind: string }, input: string, key: Key): boolean {
  if (!isManageMode(mode)) return false;
  if (handleUnmanagedKey(context, mode, input, key)) return true;
  if (handleBulkKey(context, mode, input, key)) return true;
  switch (mode.kind) {
    case "remove-scope":
      handleRemoveScopeKey(context, mode, input, key);
      break;
    case "hosts-add":
    case "hosts-remove":
      handleHostChecklistKey(context, mode, input, key);
      break;
    case "confirm-host-add":
    case "confirm-host-exposure":
    case "confirm-host-remove":
    case "confirm-uninstall":
      handleConfirmKey(context, mode, input, key);
      break;
    default:
      break;
  }
  return true;
}
