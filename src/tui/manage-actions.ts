import type { Key } from "ink";

import { APP_KINDS, type AppMode } from "./app-actions.js";
import { PACKAGE_KINDS, type PackageMode } from "./package-actions.js";
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
import { answerYesNo, applyChecklistOutcome, hostChecklistKey, movePreviewCursor } from "./mode-keys.js";
import type { PreviewChrome, PreviewGeometry } from "./preview-window.js";
import { handleUnmanagedKey, UNMANAGED_KINDS, type UnmanagedMode } from "./unmanaged-actions.js";
import { busy, type Busy } from "./working-model.js";

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
  | { readonly kind: "confirm-host-add"; readonly skill: SkillCandidate; readonly prepared: PreparedHostAddition; readonly cursor: number }
  | { readonly kind: "confirm-host-exposure"; readonly skill: SkillCandidate; readonly prepared: PreparedHostAddition }
  | { readonly kind: "confirm-host-remove"; readonly skill: SkillCandidate; readonly prepared: PreparedHostRemoval; readonly cursor: number }
  | {
      readonly kind: "confirm-uninstall";
      readonly skill: SkillCandidate;
      readonly prepared: Extract<UninstallPreparation, { kind: "ready" }>;
      readonly cursor: number;
    }
  | AppMode
  | PackageMode
  | UnmanagedMode
  | BulkMode
  | Busy;

const MANAGE_KINDS: ReadonlySet<string> = new Set<ManageMode["kind"]>([
  "remove-scope",
  "hosts-add",
  "hosts-remove",
  "confirm-host-add",
  "confirm-host-exposure",
  "confirm-host-remove",
  "confirm-uninstall",
  ...APP_KINDS,
  ...PACKAGE_KINDS,
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
  /** The viewport of a paged preview at the current terminal size, shared with the panel. */
  readonly previewGeometry: PreviewGeometry;
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
  context.setMode(busy(`Preparing uninstall of ${skill.name}…`));
  try {
    const prepared = await prepareUninstall(context.operations, context.env, skill, context.installed);
    if (!context.isMounted()) return;
    if (prepared.kind === "ready") {
      context.setMode({ kind: "confirm-uninstall", skill, prepared, cursor: 0 });
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
  context.setMode(busy(`Preparing host change of ${mode.skill.name}…`));
  try {
    if (mode.kind === "hosts-add") {
      const prepared = await prepareHostAddition(operations, env, mode.skill, installed, mode.selected);
      if (!context.isMounted()) return;
      context.setMode({ kind: "confirm-host-add", skill: mode.skill, prepared, cursor: 0 });
    } else {
      const prepared = await prepareHostRemoval(operations, env, mode.skill, installed, mode.selected);
      if (!context.isMounted()) return;
      context.setMode({ kind: "confirm-host-remove", skill: mode.skill, prepared, cursor: 0 });
    }
  } catch (error) {
    if (!context.isMounted()) return;
    context.setMessage({ kind: "error", text: errorText(error) });
    context.browse();
  }
}

/** Runs a confirmed step in the busy mode and finishes with its outcome. */
async function execute(context: ManageContext, label: string, action: () => Promise<string>): Promise<void> {
  context.setMode(busy(label));
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

export type PagedConfirmMode = ModeOf<"confirm-host-add" | "confirm-host-remove" | "confirm-uninstall">;

/** What a paged confirmation shows, so the key handler and the panel page the same rows. */
export function pagedConfirmPreview(mode: PagedConfirmMode): { readonly lines: readonly string[]; readonly chrome: PreviewChrome } {
  const name = mode.skill.name;
  switch (mode.kind) {
    case "confirm-host-add":
      return { lines: mode.prepared.preview, chrome: { title: "Add hosts", action: `Add hosts to ${name}`, consequence: `Add hosts to ${name}? y/n` } };
    case "confirm-host-remove":
      return { lines: mode.prepared.preview, chrome: { title: "Remove hosts", action: `Remove hosts from ${name}`, consequence: `Remove hosts from ${name}? y/n` } };
    case "confirm-uninstall":
      return { lines: mode.prepared.plan.preview, chrome: { title: "Uninstall", action: `Uninstall ${name}`, consequence: `Uninstall ${name}? y/n` } };
  }
}

export function isPagedConfirmMode(mode: { readonly kind: string }): mode is PagedConfirmMode {
  return mode.kind === "confirm-host-add" || mode.kind === "confirm-host-remove" || mode.kind === "confirm-uninstall";
}

/** Pages the preview like the other footer confirmations: `y` answers only once it has all been displayed. */
function handlePagedConfirmKey(context: ManageContext, mode: PagedConfirmMode, input: string, key: Key): void {
  const { operations, env } = context;
  const { lines, chrome } = pagedConfirmPreview(mode);
  const viewport = context.previewGeometry(lines, mode.cursor, chrome);
  const cursor = movePreviewCursor(mode.cursor, viewport.total, input, key, viewport.height);
  if (cursor !== undefined) {
    context.setMode({ ...mode, cursor });
    return;
  }
  answerYesNo(input, key, () => {
    if (!viewport.reachedEnd) return;
    switch (mode.kind) {
      case "confirm-host-add":
        context.setMode({ kind: "confirm-host-exposure", skill: mode.skill, prepared: mode.prepared });
        return;
      case "confirm-host-remove":
        void execute(context, `Changing hosts of ${mode.skill.name}…`, () => runHostRemoval(mode.prepared, operations, env, mode.skill));
        return;
      case "confirm-uninstall":
        void execute(context, `Removing ${mode.skill.name}…`, async () => {
          await runUninstall(mode.prepared, operations, env);
          return mode.prepared.plan.inspections.every((inspection) => inspection.recordOnly)
            ? `Forgot missing installation record for ${mode.skill.path}; no files were removed`
            : `Removed ${mode.skill.name} (${mode.skill.path})`;
        });
        return;
    }
  }, () => cancel(context, mode.kind === "confirm-host-add" ? "Install cancelled" : "Uninstall cancelled"));
}

/** The exposure question has no preview: `y` adds the hosts, `n`/Esc cancels. */
function handleExposureKey(context: ManageContext, mode: ModeOf<"confirm-host-exposure">, input: string, key: Key): void {
  answerYesNo(input, key, () => {
    void execute(context, `Changing hosts of ${mode.skill.name}…`, () => runHostAddition(mode.prepared, context.operations, context.env));
  }, () => cancel(context, "Install cancelled"));
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
    case "confirm-host-remove":
    case "confirm-uninstall":
      handlePagedConfirmKey(context, mode, input, key);
      break;
    case "confirm-host-exposure":
      handleExposureKey(context, mode, input, key);
      break;
    default:
      break;
  }
  return true;
}
