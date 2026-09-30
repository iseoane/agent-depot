import type { Key } from "ink";

import { PROJECT_HOSTS, type ProjectHost, type ProjectSkillSelection } from "../project-manifest.js";
import { assertManagedInstallationRecordsUnchanged } from "../skill-removal.js";
import type { SkillCandidate } from "../skill-discovery.js";
import type { SourceOperations } from "../sources.js";
import { errorText, runBatch } from "./batch.js";
import {
  missingHosts,
  prepareHostAddition,
  prepareUninstall,
  runHostAddition,
  runUninstall,
  UNINSTALL_REFUSALS,
  type InstalledSkills,
  type PreparedHostAddition,
  type UninstallPreparation,
} from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { skillOf, sourceIdOf, type InstallationRow, type UnmanagedGroup } from "./installations.js";
import { prepareUnmanagedRemoval, runUnmanagedRemoval, type PreparedUnmanagedRemoval } from "./unmanaged-actions.js";

/** A marked leaf of the Installations tree, keyed by its node id so the view can unmark it. */
export interface BulkTarget {
  readonly id: string;
  readonly leaf:
    | { readonly kind: "installation"; readonly row: InstallationRow }
    | { readonly kind: "unmanaged"; readonly group: UnmanagedGroup };
}

/** A marked leaf that the action cannot apply to, with the reason shown in the preview and the result. */
export interface SkippedTarget {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export type BulkUninstallItem =
  | {
      readonly kind: "managed";
      readonly id: string;
      readonly label: string;
      readonly skill: SkillCandidate;
      readonly prepared: Extract<UninstallPreparation, { kind: "ready" }>;
    }
  | { readonly kind: "unmanaged"; readonly id: string; readonly label: string; readonly prepared: PreparedUnmanagedRemoval };

export interface BulkUninstallPlan {
  readonly items: readonly BulkUninstallItem[];
  readonly skipped: readonly SkippedTarget[];
  /** The user-global records as they were when the preview was made. */
  readonly installations: readonly ProjectSkillSelection[];
}

export interface BulkHostTarget {
  readonly id: string;
  readonly label: string;
  readonly skill: SkillCandidate;
  readonly hosts: readonly ProjectHost[];
}

export interface BulkHostItem {
  readonly id: string;
  readonly label: string;
  readonly prepared: PreparedHostAddition;
}

export interface BulkHostPlan {
  readonly items: readonly BulkHostItem[];
  readonly skipped: readonly SkippedTarget[];
  readonly installations: BulkUninstallPlan["installations"];
}

/** Interaction modes of the bulk actions on marked installations; like every manage mode they capture keys. */
export type BulkMode =
  | {
      readonly kind: "bulk-hosts";
      readonly targets: readonly BulkHostTarget[];
      readonly skipped: readonly SkippedTarget[];
      readonly choices: readonly ProjectHost[];
      readonly cursor: number;
      readonly selected: readonly ProjectHost[];
    }
  | { readonly kind: "confirm-bulk-uninstall"; readonly plan: BulkUninstallPlan }
  | { readonly kind: "confirm-bulk-hosts"; readonly plan: BulkHostPlan }
  | { readonly kind: "confirm-bulk-exposure"; readonly plan: BulkHostPlan };

export const BULK_KINDS: readonly BulkMode["kind"][] = ["bulk-hosts", "confirm-bulk-uninstall", "confirm-bulk-hosts", "confirm-bulk-exposure"];

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** What the flow needs from the hosting view; the Installations view's manage context satisfies it. */
export interface BulkContext {
  readonly operations: SourceOperations;
  readonly env: TuiEnvironment;
  readonly installed: InstalledSkills;
  setMode(mode: BulkMode | { readonly kind: "busy"; readonly label: string }): void;
  browse(): void;
  setMessage(message: Message | undefined): void;
  isMounted(): boolean;
  /** Drops the marks of the items that were applied. */
  unmark(ids: readonly string[]): void;
  finish(result: Message): Promise<void>;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function skip(target: BulkTarget, label: string, reason: string): SkippedTarget {
  return { id: target.id, label, reason };
}

function labelOf(target: BulkTarget): string {
  const { leaf } = target;
  if (leaf.kind === "unmanaged") return leaf.group.name;
  return leaf.row.scope === "project" ? `${leaf.row.selection.path} (project)` : leaf.row.selection.path;
}

/** Reads the records once, so every item of the batch is checked against the same state. */
async function listRecords(operations: SourceOperations) {
  return operations.listUserGlobalInstallations ? operations.listUserGlobalInstallations() : [];
}

/**
 * Drift check before an item: the records must be exactly what the previous items were expected to leave.
 * The baseline only ever advances by the change an item made, so an outside change is never absorbed.
 */
async function assertNoDrift(operations: SourceOperations, expected: readonly ProjectSkillSelection[]): Promise<void> {
  const actual = await listRecords(operations);
  try {
    assertManagedInstallationRecordsUnchanged(expected, actual);
  } catch {
    throw new Error("The installation records changed outside this batch since the previous item; this item was left untouched");
  }
}

const sameRecord = (left: ProjectSkillSelection, right: ProjectSkillSelection) => JSON.stringify(left) === JSON.stringify(right);

/** Plan step of a bulk uninstall: prepares each marked leaf with its shared plan, or records why it is skipped. */
export async function prepareBulkUninstall(
  context: Pick<BulkContext, "operations" | "env" | "installed">,
  targets: readonly BulkTarget[],
): Promise<BulkUninstallPlan> {
  const { operations, env, installed } = context;
  const installations = await listRecords(operations);
  const items: BulkUninstallItem[] = [];
  const skipped: SkippedTarget[] = [];
  for (const target of targets) {
    const label = labelOf(target);
    const { leaf } = target;
    try {
      if (leaf.kind === "unmanaged") {
        items.push({ kind: "unmanaged", id: target.id, label, prepared: await prepareUnmanagedRemoval(operations, env, leaf.group, leaf.group.locations) });
        continue;
      }
      if (leaf.row.scope === "project") {
        skipped.push(skip(target, label, UNINSTALL_REFUSALS["project-only"]));
        continue;
      }
      const sourceId = sourceIdOf(leaf.row.selection, installed.sources);
      if (sourceId === undefined) {
        skipped.push(skip(target, label, "The Source of this installation is no longer registered"));
        continue;
      }
      const skill = skillOf(leaf.row, sourceId);
      const prepared = await prepareUninstall(operations, env, skill, installed);
      if (prepared.kind === "ready") items.push({ kind: "managed", id: target.id, label, skill, prepared });
      else skipped.push(skip(target, label, UNINSTALL_REFUSALS[prepared.kind]));
    } catch (error) {
      skipped.push(skip(target, label, errorText(error)));
    }
  }
  return { items, skipped, installations };
}

export interface BulkResult {
  readonly message: Message;
  /** Node ids of the items that were applied. */
  readonly applied: readonly string[];
}

function resultOf<T extends { readonly id: string }>(
  outcomes: readonly { readonly item: T; readonly ok: boolean; readonly line: string }[],
  skipped: readonly SkippedTarget[],
): BulkResult {
  const lines = [...outcomes.map((outcome) => outcome.line), ...skipped.map(({ label, reason }) => `Skipped ${label}: ${reason}`)];
  return {
    message: { kind: outcomes.some((outcome) => !outcome.ok) ? "error" : "ok", text: lines.join("\n") },
    applied: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.item.id),
  };
}

/** Execute step: each item is rechecked and applied on its own against the records the previous items were expected to leave. */
export async function runBulkUninstall(plan: BulkUninstallPlan, operations: SourceOperations, env: TuiEnvironment): Promise<BulkResult> {
  let expected = plan.installations;
  const outcomes = await runBatch(plan.items, async (item) => {
    await assertNoDrift(operations, expected);
    if (item.kind === "unmanaged") {
      const result = await runUnmanagedRemoval({ ...item.prepared, installations: expected }, operations, env);
      if (result.kind === "error") throw new Error(result.text);
      return result.text;
    }
    await runUninstall({ ...item.prepared, installations: expected }, operations, env);
    // Only the record this item removed moves the baseline the next item is checked against.
    expected = expected.filter((record) => !item.prepared.plan.selections.some((removed) => sameRecord(removed, record)));
    return `Removed ${item.label}`;
  }, (item, error) => (item.kind === "unmanaged" ? errorText(error) : `Failed ${item.label}: ${errorText(error)}`));
  return resultOf(outcomes, plan.skipped);
}

/** Managed user-global leaves that can gain hosts, and the leaves that cannot with their reasons. */
export function classifyHostTargets(
  context: Pick<BulkContext, "installed">,
  targets: readonly BulkTarget[],
): { readonly ready: readonly BulkHostTarget[]; readonly skipped: readonly SkippedTarget[] } {
  const ready: BulkHostTarget[] = [];
  const skipped: SkippedTarget[] = [];
  for (const target of targets) {
    const label = labelOf(target);
    const { leaf } = target;
    if (leaf.kind === "unmanaged") {
      skipped.push(skip(target, label, "Host changes are not available for unmanaged skills"));
    } else if (leaf.row.scope === "project") {
      skipped.push(skip(target, label, "Project installations are managed with the CLI"));
    } else if (missingHosts(leaf.row.selection).length === 0) {
      skipped.push(skip(target, label, "already has every host"));
    } else {
      const sourceId = sourceIdOf(leaf.row.selection, context.installed.sources);
      if (sourceId === undefined) skipped.push(skip(target, label, "The Source of this installation is no longer registered"));
      else ready.push({ id: target.id, label, skill: skillOf(leaf.row, sourceId), hosts: leaf.row.selection.hosts });
    }
  }
  return { ready, skipped };
}

/** Plan step after the checklist: each item adds only the chosen hosts it lacks. */
export async function prepareBulkHostAddition(
  context: Pick<BulkContext, "operations" | "env" | "installed">,
  targets: readonly BulkHostTarget[],
  alreadySkipped: readonly SkippedTarget[],
  chosen: readonly ProjectHost[],
): Promise<BulkHostPlan> {
  const { operations, env, installed } = context;
  const installations = await listRecords(operations);
  const items: BulkHostItem[] = [];
  const skipped = [...alreadySkipped];
  for (const target of targets) {
    const lacking = chosen.filter((host) => !target.hosts.includes(host));
    if (lacking.length === 0) {
      skipped.push({ id: target.id, label: target.label, reason: `already has ${chosen.join(", ")}` });
      continue;
    }
    try {
      items.push({ id: target.id, label: target.label, prepared: await prepareHostAddition(operations, env, target.skill, installed, lacking) });
    } catch (error) {
      skipped.push({ id: target.id, label: target.label, reason: errorText(error) });
    }
  }
  return { items, skipped, installations };
}

/** Execute step: the single exposure confirmation covers every item; each one is rechecked on its own. */
export async function runBulkHostAddition(plan: BulkHostPlan, operations: SourceOperations, env: TuiEnvironment): Promise<BulkResult> {
  let expected = plan.installations;
  const outcomes = await runBatch(plan.items, async (item) => {
    await assertNoDrift(operations, expected);
    const line = await runHostAddition({ ...item.prepared, installations: expected }, operations, env);
    // Only the record this item updated moves the baseline the next item is checked against.
    const { selection, updated } = item.prepared.plan;
    expected = expected.map((record) => (sameRecord(record, selection) ? updated : record));
    return line;
  }, (item, error) => `Failed ${item.label}: ${errorText(error)}`);
  return resultOf(outcomes, plan.skipped);
}

function cancel(context: BulkContext, text: string): void {
  context.setMessage({ kind: "ok", text });
  context.browse();
}

/** `u` with marks: prepares every marked leaf, then asks once. */
export async function startBulkUninstall(context: BulkContext, targets: readonly BulkTarget[]): Promise<void> {
  context.setMode({ kind: "busy", label: `Preparing uninstall of ${count(targets.length, "item")}...` });
  try {
    const plan = await prepareBulkUninstall(context, targets);
    if (!context.isMounted()) return;
    if (plan.items.length === 0) {
      context.setMessage({ kind: "error", text: plan.skipped.map(({ label, reason }) => `Skipped ${label}: ${reason}`).join("\n") });
      context.browse();
      return;
    }
    context.setMode({ kind: "confirm-bulk-uninstall", plan });
  } catch (error) {
    if (!context.isMounted()) return;
    context.setMessage({ kind: "error", text: errorText(error) });
    context.browse();
  }
}

/** `h` with marks: asks the hosts once, for the union of what the eligible items lack. */
export function startBulkHostAddition(context: BulkContext, targets: readonly BulkTarget[]): void {
  const { ready, skipped } = classifyHostTargets(context, targets);
  const choices = PROJECT_HOSTS.filter((host) => ready.some((target) => !target.hosts.includes(host)));
  if (ready.length === 0) {
    context.setMessage({ kind: "error", text: skipped.map(({ label, reason }) => `Skipped ${label}: ${reason}`).join("\n") });
    return;
  }
  context.setMessage(undefined);
  context.setMode({ kind: "bulk-hosts", targets: ready, skipped, choices, cursor: 0, selected: [] });
}

async function prepareHosts(context: BulkContext, mode: Extract<BulkMode, { kind: "bulk-hosts" }>): Promise<void> {
  context.setMode({ kind: "busy", label: `Preparing host change of ${count(mode.targets.length, "item")}...` });
  try {
    const plan = await prepareBulkHostAddition(context, mode.targets, mode.skipped, mode.selected);
    if (!context.isMounted()) return;
    if (plan.items.length === 0) {
      context.setMessage({ kind: "error", text: plan.skipped.map(({ label, reason }) => `Skipped ${label}: ${reason}`).join("\n") });
      context.browse();
      return;
    }
    context.setMode({ kind: "confirm-bulk-hosts", plan });
  } catch (error) {
    if (!context.isMounted()) return;
    context.setMessage({ kind: "error", text: errorText(error) });
    context.browse();
  }
}

async function apply(context: BulkContext, label: string, action: () => Promise<BulkResult>): Promise<void> {
  context.setMode({ kind: "busy", label });
  let result: BulkResult;
  try {
    result = await action();
  } catch (error) {
    result = { message: { kind: "error", text: errorText(error) }, applied: [] };
  }
  context.unmark(result.applied);
  await context.finish(result.message);
}

/** Handles a key in a bulk mode; returns false for any other mode. */
export function handleBulkKey(context: BulkContext, mode: { readonly kind: string }, input: string, key: Key): boolean {
  const current = mode as BulkMode;
  const { operations, env } = context;
  switch (current.kind) {
    case "bulk-hosts": {
      const toggle = (host: ProjectHost) =>
        current.choices.filter((candidate) => candidate === host ? !current.selected.includes(candidate) : current.selected.includes(candidate));
      const numbered = current.choices[Number(input) - 1];
      if (key.escape) cancel(context, "Add hosts cancelled");
      else if (key.downArrow || input === "j") context.setMode({ ...current, cursor: Math.min(current.cursor + 1, current.choices.length - 1) });
      else if (key.upArrow || input === "k") context.setMode({ ...current, cursor: Math.max(current.cursor - 1, 0) });
      else if (input === " ") context.setMode({ ...current, selected: toggle(current.choices[current.cursor]!) });
      else if (numbered) context.setMode({ ...current, selected: toggle(numbered) });
      else if (key.return) {
        if (current.selected.length > 0) void prepareHosts(context, current);
        else context.setMessage({ kind: "error", text: "Select at least one host" });
      }
      return true;
    }
    case "confirm-bulk-uninstall":
      if (input === "y") {
        void apply(context, `Removing ${count(current.plan.items.length, "item")}...`, () => runBulkUninstall(current.plan, operations, env));
      } else if (input === "n" || key.escape) cancel(context, "Uninstall cancelled");
      return true;
    case "confirm-bulk-hosts":
      if (input === "y") context.setMode({ kind: "confirm-bulk-exposure", plan: current.plan });
      else if (input === "n" || key.escape) cancel(context, "Add hosts cancelled");
      return true;
    case "confirm-bulk-exposure":
      if (input === "y") {
        void apply(context, `Changing hosts of ${count(current.plan.items.length, "item")}...`, () => runBulkHostAddition(current.plan, operations, env));
      } else if (input === "n" || key.escape) cancel(context, "Add hosts cancelled");
      return true;
    default:
      return false;
  }
}
