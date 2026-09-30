import type { Key } from "ink";

import type { SkillCandidate } from "../skill-discovery.js";
import type { SourceOperations } from "../sources.js";
import { BROWSE, describeSkills, HOST_CHOICES, SCOPE_CHOICES, type ActionMode, type BatchItem } from "./catalog-actions.js";
import { prepareInstall, runInstall } from "./catalog-installs.js";
import { skillKey } from "./catalog-tree.js";
import type { TuiEnvironment } from "./environment.js";
import { errorText, runBatch } from "./batch.js";
import { answerYesNo, hostChecklistKey, versionInputKey } from "./mode-keys.js";
import type { ViewMessage } from "./view-state.js";

/** What the install flow needs from the Catalog view; the view owns its state and reloading. */
export interface CatalogFlowContext {
  readonly operations: SourceOperations;
  readonly env: TuiEnvironment;
  setAction(mode: ActionMode): void;
  setMessage(message: ViewMessage | undefined): void;
  isMounted(): boolean;
  /** Keeps exactly these Skills marked. */
  keepMarked(ids: ReadonlySet<string>): void;
  /** Reloads the installed set first so the result and the vanished Skills appear together, then browses. */
  finish(result: ViewMessage): Promise<void>;
}

type ModeOf<K extends ActionMode["kind"]> = Extract<ActionMode, { kind: K }>;

function cancel(context: CatalogFlowContext): void {
  context.setMessage({ kind: "ok", text: "Install cancelled" });
  context.setAction(BROWSE);
}

async function startInstall(
  context: CatalogFlowContext,
  skills: readonly SkillCandidate[],
  choice: Parameters<typeof prepareInstall>[3],
): Promise<void> {
  context.setAction({ kind: "busy", label: `Refreshing source and preparing install of ${describeSkills(skills)}...` });
  const items: BatchItem[] = [];
  for (const skill of skills) {
    try {
      items.push({ skill, prepared: await prepareInstall(context.operations, context.env, skill, choice) });
    } catch (error) {
      items.push({ skill, error: errorText(error) });
    }
  }
  if (!context.isMounted()) return;
  if (items.every((item) => item.prepared === undefined)) {
    const text = items.length === 1 ? items[0]!.error! : items.map((item) => `Failed ${item.skill.name}: ${item.error}`).join("\n");
    context.setMessage({ kind: "error", text });
    context.setAction(BROWSE);
    return;
  }
  context.setAction({ kind: "confirm-install", items });
}

/** Applies the prepared items one by one; a failure is reported for that item and the rest still run. */
async function confirmInstall(context: CatalogFlowContext, items: readonly BatchItem[], exposure: boolean): Promise<void> {
  context.setAction({ kind: "busy", label: `Installing ${describeSkills(items.map((item) => item.skill))}...` });
  const outcomes = await runBatch(items, async ({ prepared, error }) => {
    if (prepared === undefined) throw new Error(error);
    return (await runInstall(prepared, context.operations, exposure && prepared.additionalHostExposure)).join(" ");
  }, ({ skill }, caught) => `Failed ${skill.name}: ${errorText(caught)}`);
  const lines = outcomes.map((outcome) => outcome.line);
  const failed = new Set(outcomes.filter((outcome) => !outcome.ok).map((outcome) => skillKey(outcome.item.skill)));
  // Installed Skills leave the list; only the failed ones stay marked for another try.
  context.keepMarked(failed);
  await context.finish({ kind: failed.size > 0 ? "error" : "ok", text: lines.join("\n") });
}

function handleHostKey(context: CatalogFlowContext, mode: ModeOf<"host">, input: string, key: Key): void {
  const outcome = hostChecklistKey(mode, HOST_CHOICES, input, key);
  if (outcome.kind === "cancel") cancel(context);
  else if (outcome.kind === "update") context.setAction({ ...mode, ...outcome.state });
  else if (outcome.kind === "submit") context.setAction({ kind: "scope", skills: mode.skills, hosts: outcome.selected });
  else if (outcome.kind === "empty") context.setMessage({ kind: "error", text: "Select at least one host" });
}

function handleScopeKey(context: CatalogFlowContext, mode: ModeOf<"scope">, input: string, key: Key): void {
  const scope = SCOPE_CHOICES[Number(input) - 1];
  if (key.escape) cancel(context);
  else if (scope) context.setAction({ kind: "version", skills: mode.skills, hosts: mode.hosts, scope });
}

function handleVersionKey(context: CatalogFlowContext, mode: ModeOf<"version">, input: string, key: Key): void {
  if (key.escape) cancel(context);
  else if (input === "1") void startInstall(context, mode.skills, { hosts: mode.hosts, scope: mode.scope, version: { policy: "latest" } });
  else if (input === "2") context.setAction({ ...mode, kind: "fixed", value: "" });
}

function handleFixedKey(context: CatalogFlowContext, mode: ModeOf<"fixed">, input: string, key: Key): void {
  const outcome = versionInputKey(mode.value, input, key);
  if (outcome.kind === "cancel") cancel(context);
  else if (outcome.kind === "submit") {
    void startInstall(context, mode.skills, { hosts: mode.hosts, scope: mode.scope, version: { policy: "fixed", version: mode.value } });
  } else if (outcome.kind === "edit") context.setAction({ ...mode, value: outcome.value });
}

/** Handles a key in one of the install modes; `browse` and `busy` ignore keys. */
export function handleCatalogActionKey(context: CatalogFlowContext, mode: ActionMode, input: string, key: Key): void {
  switch (mode.kind) {
    case "host":
      handleHostKey(context, mode, input, key);
      return;
    case "scope":
      handleScopeKey(context, mode, input, key);
      return;
    case "version":
      handleVersionKey(context, mode, input, key);
      return;
    case "fixed":
      handleFixedKey(context, mode, input, key);
      return;
    case "confirm-install":
      answerYesNo(input, key, () => {
        if (mode.items.some((item) => item.prepared?.additionalHostExposure)) context.setAction({ ...mode, kind: "confirm-exposure" });
        else void confirmInstall(context, mode.items, false);
      }, () => cancel(context));
      return;
    case "confirm-exposure":
      answerYesNo(input, key, () => void confirmInstall(context, mode.items, true), () => cancel(context));
      return;
    default:
      return;
  }
}
