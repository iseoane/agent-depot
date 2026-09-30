import { realpath } from "node:fs/promises";
import path from "node:path";

import type { Key } from "ink";

import type { ProjectSkillSelection } from "../project-manifest.js";
import type { SourceOperations } from "../sources.js";
import {
  describeUnmanagedRemoval,
  describeUnmanagedSymlinkRemoval,
  removeInspectedUnmanagedSkill,
  removeInspectedUnmanagedSymlink,
} from "../unmanaged-removal.js";
import {
  inspectUserGlobalSkillRemoval,
  inspectUserGlobalSymlinkRemoval,
  type UserGlobalSkillRemovalInspection,
  type UserGlobalSymlinkRemovalInspection,
} from "../user-global-skill-inventory.js";
import type { TuiEnvironment } from "./environment.js";
import { answerYesNo, moveCursor } from "./mode-keys.js";
import { homeOf, type UnmanagedGroup, type UnmanagedLocation } from "./installations.js";

/** One location ready to be removed: a real directory or only a symbolic link. */
export type PlannedUnmanagedRemoval =
  | {
      readonly kind: "directory";
      readonly inspection: UserGlobalSkillRemovalInspection;
      /** Links in the plan that point at this directory; it is kept when one of them cannot be removed. */
      readonly links: readonly string[];
    }
  | { readonly kind: "link"; readonly inspection: UserGlobalSymlinkRemovalInspection };

export interface PreparedUnmanagedRemoval {
  readonly items: readonly PlannedUnmanagedRemoval[];
  /** The records as they were when the preview was made; removal fails closed when they change. */
  readonly installations: readonly ProjectSkillSelection[];
  readonly preview: readonly string[];
}

/** Interaction modes of the unmanaged removal flow; like every manage mode they capture keys. */
export type UnmanagedMode =
  | { readonly kind: "unmanaged-scope"; readonly group: UnmanagedGroup }
  | { readonly kind: "unmanaged-pick"; readonly group: UnmanagedGroup; readonly cursor: number; readonly selected: readonly string[] }
  | { readonly kind: "confirm-unmanaged"; readonly group: UnmanagedGroup; readonly prepared: PreparedUnmanagedRemoval };

export const UNMANAGED_KINDS: readonly UnmanagedMode["kind"][] = ["unmanaged-scope", "unmanaged-pick", "confirm-unmanaged"];

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** What the flow needs from the hosting view; the Installations view's manage context satisfies it. */
export interface UnmanagedContext {
  readonly operations: SourceOperations;
  readonly env: TuiEnvironment;
  setMode(mode: UnmanagedMode | { readonly kind: "busy"; readonly label: string }): void;
  browse(): void;
  setMessage(message: Message | undefined): void;
  isMounted(): boolean;
  finish(result: Message): Promise<void>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Links first, so a Claude link never outlives the canonical directory it points to. */
function linksFirst(locations: readonly UnmanagedLocation[]): readonly UnmanagedLocation[] {
  return [...locations].sort((left, right) => Number(left.linkTarget === undefined) - Number(right.linkTarget === undefined));
}

/** The canonical form of a path, or its normalized form when it cannot be resolved (a dangling target). */
async function canonical(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** The links of the group that point at `directory`, whether or not they were chosen. */
async function linksTargeting(group: UnmanagedGroup, directory: string): Promise<readonly UnmanagedLocation[]> {
  const wanted = await canonical(directory);
  const found: UnmanagedLocation[] = [];
  for (const candidate of group.locations) {
    if (candidate.linkTarget === undefined) continue;
    if (await canonical(path.resolve(path.dirname(candidate.path), candidate.linkTarget)) === wanted) found.push(candidate);
  }
  return found;
}

/** Plan step: inspects every chosen location exactly as the CLI does; changes nothing. */
export async function prepareUnmanagedRemoval(
  operations: SourceOperations,
  environment: TuiEnvironment,
  group: UnmanagedGroup,
  locations: readonly UnmanagedLocation[],
): Promise<PreparedUnmanagedRemoval> {
  if (!operations.listUserGlobalInstallations) throw new Error("Uninstall is not supported by the configured operations");
  const installations = await operations.listUserGlobalInstallations();
  const options = { homeDirectory: homeOf(environment), managedInstallations: installations };
  const items: PlannedUnmanagedRemoval[] = [];
  const preview = [`WARNING: agent-depot did not create these files (unmanaged skill ${group.name})`];
  // A chosen directory takes the links that point at it along, so none is left dangling.
  const planned = new Map(locations.map((chosen) => [chosen.path, chosen]));
  const dependents = new Map<string, readonly UnmanagedLocation[]>();
  for (const chosen of locations) {
    if (chosen.linkTarget !== undefined) continue;
    const links = await linksTargeting(group, chosen.path);
    dependents.set(chosen.path, links);
    for (const link of links) {
      if (planned.has(link.path)) continue;
      planned.set(link.path, link);
      preview.push(`also removes link ${JSON.stringify(link.path)} → ${JSON.stringify(chosen.path)} (it would dangle)`);
    }
  }
  for (const location of linksFirst([...planned.values()])) {
    if (location.linkTarget !== undefined) {
      const inspection = await inspectUserGlobalSymlinkRemoval(location.path, options);
      items.push({ kind: "link", inspection });
      preview.push(...describeUnmanagedSymlinkRemoval(inspection));
    } else {
      const inspection = await inspectUserGlobalSkillRemoval(location.path, options);
      items.push({ kind: "directory", inspection, links: (dependents.get(location.path) ?? []).map((link) => link.path) });
      preview.push(...describeUnmanagedRemoval(inspection));
    }
  }
  return { items, installations, preview };
}

/** Execute step: each location is rechecked and removed on its own, so one failure does not stop the others. */
export async function runUnmanagedRemoval(
  prepared: PreparedUnmanagedRemoval,
  operations: SourceOperations,
  environment: TuiEnvironment,
): Promise<Message> {
  const context = { operations, homeDirectory: homeOf(environment) };
  const lines: string[] = [];
  let failed = false;
  const notRemoved = new Set<string>();
  for (const item of prepared.items) {
    const { path: location } = item.inspection;
    const blocking = item.kind === "directory" ? item.links.find((link) => notRemoved.has(link)) : undefined;
    if (blocking !== undefined) {
      failed = true;
      notRemoved.add(location);
      lines.push(`Skipped ${location}: link ${blocking} could not be removed`);
      continue;
    }
    try {
      if (item.kind === "link") await removeInspectedUnmanagedSymlink(context, item.inspection, prepared.installations);
      else await removeInspectedUnmanagedSkill(context, item.inspection, prepared.installations);
      lines.push(`Removed ${location}`);
    } catch (error) {
      failed = true;
      notRemoved.add(location);
      lines.push(`Failed ${location}: ${errorText(error)}`);
    }
  }
  return { kind: failed ? "error" : "ok", text: lines.join("\n") };
}

async function startPreview(context: UnmanagedContext, group: UnmanagedGroup, locations: readonly UnmanagedLocation[]): Promise<void> {
  context.setMode({ kind: "busy", label: `Preparing removal of ${group.name}...` });
  try {
    const prepared = await prepareUnmanagedRemoval(context.operations, context.env, group, locations);
    if (!context.isMounted()) return;
    context.setMode({ kind: "confirm-unmanaged", group, prepared });
  } catch (error) {
    if (!context.isMounted()) return;
    context.setMessage({ kind: "error", text: errorText(error) });
    context.browse();
  }
}

/** `u` on an unmanaged skill: one location goes straight to the preview; several ask all or choose. */
export function startUnmanagedRemoval(context: UnmanagedContext, group: UnmanagedGroup): void {
  if (group.locations.length > 1) context.setMode({ kind: "unmanaged-scope", group });
  else void startPreview(context, group, group.locations);
}

function cancel(context: UnmanagedContext): void {
  context.setMessage({ kind: "ok", text: "Uninstall cancelled" });
  context.browse();
}

async function execute(context: UnmanagedContext, group: UnmanagedGroup, prepared: PreparedUnmanagedRemoval): Promise<void> {
  context.setMode({ kind: "busy", label: `Removing ${group.name}...` });
  await context.finish(await runUnmanagedRemoval(prepared, context.operations, context.env));
}

/** Handles a key in an unmanaged removal mode; returns false for any other mode. */
export function handleUnmanagedKey(context: UnmanagedContext, mode: { readonly kind: string }, input: string, key: Key): boolean {
  const current = mode as UnmanagedMode;
  switch (current.kind) {
    case "unmanaged-scope":
      if (key.escape) cancel(context);
      else if (input === "1") void startPreview(context, current.group, current.group.locations);
      else if (input === "2") context.setMode({ kind: "unmanaged-pick", group: current.group, cursor: 0, selected: [] });
      return true;
    case "unmanaged-pick": {
      const { locations } = current.group;
      const toggle = (index: number) => {
        const location = locations[index];
        if (!location) return;
        const selected = current.selected.includes(location.path)
          ? current.selected.filter((candidate) => candidate !== location.path)
          : [...current.selected, location.path];
        context.setMode({ ...current, selected });
      };
      const cursor = moveCursor(current.cursor, locations.length, input, key);
      if (key.escape) cancel(context);
      else if (cursor !== undefined) context.setMode({ ...current, cursor });
      else if (input === " ") toggle(current.cursor);
      else if (Number(input) >= 1 && Number(input) <= locations.length) toggle(Number(input) - 1);
      else if (key.return) {
        const chosen = locations.filter((location) => current.selected.includes(location.path));
        if (chosen.length > 0) void startPreview(context, current.group, chosen);
        else context.setMessage({ kind: "error", text: "Select at least one location" });
      }
      return true;
    }
    case "confirm-unmanaged":
      answerYesNo(input, key, () => void execute(context, current.group, current.prepared), () => cancel(context));
      return true;
    default:
      return false;
  }
}
