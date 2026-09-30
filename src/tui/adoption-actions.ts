import type { Key } from "ink";

import type { SourceOperations } from "../sources.js";
import { HOST_CHOICES } from "./catalog-actions.js";
import { runInstall } from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { errorText } from "./batch.js";
import { defaultAdoptionHosts, findAdoptionCandidates, prepareAdoption, type UnmanagedGroup } from "./installations.js";
import type { InstallationsMode } from "./installations-mode.js";
import { answerYesNo, hostChecklistKey, moveCursor, versionInputKey } from "./mode-keys.js";
import type { ViewMessage } from "./view-state.js";

/** What the adoption flow needs from the hosting view; the view owns its mode state and reloading. */
export interface AdoptionContext {
  readonly operations: SourceOperations;
  readonly env: TuiEnvironment;
  setMode(mode: InstallationsMode): void;
  /** Returns the view to browsing. */
  browse(): void;
  setMessage(message: ViewMessage | undefined): void;
  isMounted(): boolean;
  reload(): Promise<void>;
}

type ModeOf<K extends InstallationsMode["kind"]> = Extract<InstallationsMode, { kind: K }>;

function cancel(context: AdoptionContext): void {
  context.setMessage({ kind: "ok", text: "Adoption cancelled" });
  context.browse();
}

function fail(context: AdoptionContext, error: unknown): void {
  if (!context.isMounted()) return;
  context.setMessage({ kind: "error", text: errorText(error) });
  context.browse();
}

/** `A` / Enter on an unmanaged Skill: looks for the Source Skills it could be adopted as. */
export async function startAdoption(context: AdoptionContext, group: UnmanagedGroup): Promise<void> {
  // Adoption keeps an existing directory in place, so it needs a real directory (the shared root first).
  const entry = group.locations.find((location) => location.entry !== undefined)?.entry;
  if (entry === undefined) {
    context.setMessage({ kind: "error", text: "Adoption is not available for symlinks" });
    return;
  }
  context.setMessage(undefined);
  context.setMode({ kind: "busy", label: `Looking for a Source Skill named ${entry.name}...` });
  try {
    const candidates = await findAdoptionCandidates(context.operations, entry);
    if (!context.isMounted()) return;
    if (candidates.length === 0) {
      context.setMessage({ kind: "error", text: `No Source Skill named "${entry.name}" exists in the registered Sources, so ${entry.path} cannot be adopted` });
      context.browse();
    } else if (candidates.length === 1) {
      context.setMode({ kind: "host", entry, skill: candidates[0]!, cursor: 0, selected: defaultAdoptionHosts(entry) });
    } else {
      context.setMode({ kind: "pick", entry, candidates, cursor: 0 });
    }
  } catch (error) {
    fail(context, error);
  }
}

async function prepare(
  context: AdoptionContext,
  mode: ModeOf<"version" | "fixed">,
  version: Parameters<typeof prepareAdoption>[4]["version"],
): Promise<void> {
  context.setMode({ kind: "busy", label: `Refreshing source and checking that ${mode.entry.name} matches...` });
  try {
    const adoption = await prepareAdoption(context.operations, context.env, mode.entry, mode.skill, { hosts: mode.hosts, version });
    if (!context.isMounted()) return;
    context.setMode({ kind: "confirm", entry: mode.entry, skill: mode.skill, adoption });
  } catch (error) {
    fail(context, error);
  }
}

async function confirm(context: AdoptionContext, mode: ModeOf<"confirm" | "confirm-exposure">, exposure: boolean): Promise<void> {
  context.setMode({ kind: "busy", label: `Adopting ${mode.entry.name}...` });
  let result: ViewMessage;
  try {
    result = { kind: "ok", text: (await runInstall(mode.adoption.prepared, context.operations, exposure)).join(" ") };
  } catch (error) {
    result = { kind: "error", text: errorText(error) };
  }
  await context.reload();
  if (!context.isMounted()) return;
  context.setMessage(result);
  context.browse();
}

function handlePickKey(context: AdoptionContext, mode: ModeOf<"pick">, input: string, key: Key): void {
  const cursor = moveCursor(mode.cursor, mode.candidates.length, input, key);
  if (key.escape) cancel(context);
  else if (cursor !== undefined) context.setMode({ ...mode, cursor });
  else if (key.return) {
    context.setMode({ kind: "host", entry: mode.entry, skill: mode.candidates[mode.cursor]!, cursor: 0, selected: defaultAdoptionHosts(mode.entry) });
  }
}

function handleHostKey(context: AdoptionContext, mode: ModeOf<"host">, input: string, key: Key): void {
  const outcome = hostChecklistKey(mode, HOST_CHOICES, input, key);
  if (outcome.kind === "cancel") cancel(context);
  else if (outcome.kind === "update") context.setMode({ ...mode, ...outcome.state });
  else if (outcome.kind === "submit") context.setMode({ kind: "version", entry: mode.entry, skill: mode.skill, hosts: outcome.selected });
  else if (outcome.kind === "empty") context.setMessage({ kind: "error", text: "Select at least one host" });
}

function handleVersionKey(context: AdoptionContext, mode: ModeOf<"version">, input: string, key: Key): void {
  if (key.escape) cancel(context);
  else if (input === "1") void prepare(context, mode, { policy: "latest" });
  else if (input === "2") context.setMode({ ...mode, kind: "fixed", value: "" });
}

function handleFixedKey(context: AdoptionContext, mode: ModeOf<"fixed">, input: string, key: Key): void {
  const outcome = versionInputKey(mode.value, input, key);
  if (outcome.kind === "cancel") cancel(context);
  else if (outcome.kind === "submit") void prepare(context, mode, { policy: "fixed", version: mode.value });
  else if (outcome.kind === "edit") context.setMode({ ...mode, value: outcome.value });
}

function handleConfirmKey(context: AdoptionContext, mode: ModeOf<"confirm">, input: string, key: Key): void {
  if (!mode.adoption.verdict.adoptable) {
    if (key.escape || key.return || input === "n") cancel(context);
    return;
  }
  answerYesNo(input, key, () => {
    if (mode.adoption.prepared.additionalHostExposure) context.setMode({ ...mode, kind: "confirm-exposure" });
    else void confirm(context, mode, false);
  }, () => cancel(context));
}

/** Handles a key in an adoption mode; other modes are ignored. */
export function handleAdoptionKey(context: AdoptionContext, mode: InstallationsMode, input: string, key: Key): void {
  switch (mode.kind) {
    case "pick":
      handlePickKey(context, mode, input, key);
      return;
    case "host":
      handleHostKey(context, mode, input, key);
      return;
    case "version":
      handleVersionKey(context, mode, input, key);
      return;
    case "fixed":
      handleFixedKey(context, mode, input, key);
      return;
    case "confirm":
      handleConfirmKey(context, mode, input, key);
      return;
    case "confirm-exposure":
      answerYesNo(input, key, () => void confirm(context, mode, true), () => cancel(context));
      return;
    default:
      return;
  }
}
