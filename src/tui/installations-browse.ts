import type { Key } from "ink";

import type { AppEntry } from "../app-flow.js";

import { startBulkHostAddition, startBulkUninstall, type BulkTarget } from "./bulk-actions.js";
import { skillOf, sourceIdOf, type InstallationsData, type UnmanagedGroup } from "./installations.js";
import { leavesOf, targetOf, type InstallationNode, type NodeData } from "./installations-tree.js";
import { startHostAddition, startUninstall, type ManageContext } from "./manage-actions.js";
import { startUnmanagedRemoval } from "./unmanaged-actions.js";
import { navigateTree, type TreeNavigation, type TreeSnapshot } from "./tree-navigation.js";
import { toggleNode, type VisibleRow } from "./tree.js";
import { toggledMark, type Marks, type ViewMessage } from "./view-state.js";

/** Why a key does nothing on a group row. */
const GROUP_ROW_MESSAGE: Record<"A" | "u" | "h" | "i", string> = {
  A: "Adoption is not available for group rows",
  u: "Uninstall is not available for group rows",
  h: "Host changes are not available for group rows",
  i: "Host changes are not available for group rows",
};

/** What browsing the Installations tree needs from the view. */
export interface BrowseContext {
  readonly navigation: TreeNavigation<NodeData>;
  readonly height: number;
  readonly marks: Marks;
  /** Undefined while the installations are loading. */
  readonly data: InstallationsData | undefined;
  readonly manage: ManageContext;
  readonly startApps: (entries: readonly AppEntry[], input: string) => void;
  readonly startAdoption: (group: UnmanagedGroup) => void;
  setMessage(message: ViewMessage | undefined): void;
}

type Row = VisibleRow<NodeData>;

/** The marked leaves in display order; marks whose rows no longer exist are ignored. */
function markedTargets(context: BrowseContext): readonly BulkTarget[] {
  const roots: readonly InstallationNode[] = context.navigation.latestRoots();
  return leavesOf(roots).filter((node) => context.marks.markedRef.current.has(node.id)).flatMap((node) => targetOf(node) ?? []);
}

function markRow(context: BrowseContext, row: Row | undefined): void {
  if (!row) return;
  if (row.node.data.kind === "group") {
    context.setMessage({ kind: "error", text: "Mark skills, not group rows" });
    return;
  }
  context.setMessage(undefined);
  context.marks.setMarked(toggledMark(context.marks.markedRef.current, row.node.id));
}

/** `a`: marks every listed leaf, or unmarks them when they are all marked already. */
function markAllListed(context: BrowseContext, visible: readonly Row[]): void {
  const { markedRef, setMarked } = context.marks;
  const leaves = visible.filter((candidate) => candidate.node.data.kind !== "group").map((candidate) => candidate.node.id);
  if (leaves.length === 0) {
    context.setMessage({ kind: "error", text: "There are no skills to select" });
    return;
  }
  context.setMessage(undefined);
  const all = leaves.every((id) => markedRef.current.has(id));
  setMarked(all
    ? new Set([...markedRef.current].filter((id) => !leaves.includes(id)))
    : new Set([...markedRef.current, ...leaves]));
}

function actOnUnmanaged(context: BrowseContext, group: UnmanagedGroup, input: string, key: Key): void {
  if (input === "u") startUnmanagedRemoval(context.manage, group);
  else if (input === "A" || key.return) context.startAdoption(group);
  else context.setMessage({ kind: "error", text: "Host changes are not available for unmanaged skills" });
}

function actOnInstallation(
  context: BrowseContext,
  data: InstallationsData,
  item: Extract<NodeData, { kind: "installation" }>,
  input: string,
  key: Key,
): void {
  if (input === "A" || key.return) {
    context.setMessage({ kind: "error", text: "Adoption applies to unmanaged skills; u uninstalls and h adds hosts here" });
    return;
  }
  if (item.row.scope === "project") {
    context.setMessage({ kind: "error", text: input === "u" ? "Project uninstall is not supported" : "Project installations are managed with the CLI" });
    return;
  }
  const sourceId = sourceIdOf(item.row.selection, data.sources);
  if (sourceId === undefined) {
    context.setMessage({ kind: "error", text: "The Source of this installation is no longer registered" });
    return;
  }
  const skill = skillOf(item.row, sourceId);
  if (input === "u") startUninstall(context.manage, skill);
  else startHostAddition(context.manage, skill);
}

/** `A`, Enter, `u`, `h` and `i` on the highlighted row. */
function actOnRow(context: BrowseContext, snapshot: TreeSnapshot<NodeData>, row: Row | undefined, input: string, key: Key): void {
  const { data } = context;
  if (!row || !data) return;
  const item = row.node.data;
  if (item.kind === "group") {
    if (key.return) context.navigation.setExpanded(toggleNode(snapshot.open, row));
    else context.setMessage({ kind: "error", text: GROUP_ROW_MESSAGE[input as keyof typeof GROUP_ROW_MESSAGE] });
    return;
  }
  context.setMessage(undefined);
  if (item.kind === "unmanaged") actOnUnmanaged(context, item.group, input, key);
  else if (item.kind === "app") {
    if (input === "A") context.setMessage({ kind: "error", text: "Adoption applies to unmanaged Skills, not Apps" });
    else if (key.return && item.row.inspection.status !== "needs approval") {
      const { entry, inspection } = item.row;
      const approved = inspection.status === "installed" || inspection.status === "not installed";
      context.setMessage({
        kind: approved ? "ok" : "error",
        text: approved ? `${entry.recipe?.name ?? entry.file} is already approved` : inspection.reason ?? inspection.status,
      });
    } else context.startApps([item.row.entry], key.return ? "approve" : input);
  }
  else if (item.kind === "installation") actOnInstallation(context, data, item, input, key);
}

/** Keys while browsing: navigation, marks, bulk actions and the per-row actions. */
export function handleBrowseKey(context: BrowseContext, input: string, key: Key): void {
  const snapshot = context.navigation.latest();
  if (navigateTree(context.navigation, snapshot, context.height, input, key)) return;
  const row = snapshot.visible[snapshot.at];
  const rowAction = input === "A" || key.return || input === "u" || input === "h" || input === "i";
  const appMarks = leavesOf(context.navigation.latestRoots()).filter(node => context.marks.markedRef.current.has(node.id) && node.data.kind === "app");
  if ((input === "u" || input === "h" || input === "i") && appMarks.length) {
    if (markedTargets(context).length) context.setMessage({ kind: "error", text: "Select Apps or Skills separately for bulk actions" });
    else context.startApps(appMarks.flatMap(node => node.data.kind === "app" ? [node.data.row.entry] : []), input);
  } else if (input === " ") markRow(context, row);
  else if (input === "a") markAllListed(context, snapshot.visible);
  else if ((input === "u" || input === "h" || input === "i") && context.data && markedTargets(context).length > 0) {
    // Marks, including those on collapsed rows, turn the action into a bulk one.
    context.setMessage(undefined);
    const targets = markedTargets(context);
    if (input === "u") void startBulkUninstall(context.manage, targets);
    else startBulkHostAddition(context.manage, targets);
  } else if (rowAction) actOnRow(context, snapshot, row, input, key);
}
