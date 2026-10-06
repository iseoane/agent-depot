import type { Key } from "ink";

import type { SkillCandidate } from "../skill-discovery.js";
import { type ActionMode } from "./catalog-actions.js";
import { packageOwnedSkillAction } from "./catalog-ownership.js";
import { looseLeavesOf, skillKey, type NodeData } from "./catalog-tree.js";
import type { CatalogFilterControls } from "./catalog-state.js";
import type { PackageTarget } from "./package-actions.js";
import { navigateTree, type TreeNavigation } from "./tree-navigation.js";
import { toggleNode, type VisibleRow } from "./tree.js";
import { toggledMark, type Marks, type ViewMessage } from "./view-state.js";

/** What browsing the Catalog needs from the view. */
export interface CatalogBrowseContext {
  readonly navigation: TreeNavigation<NodeData>;
  readonly height: number;
  readonly marks: Marks;
  readonly filter: CatalogFilterControls;
  /** The Catalog is scoped to one Source, so `s` can widen it to all of them. */
  readonly canWiden: boolean;
  /** Skills are loaded, so installing is possible. */
  readonly ready: boolean;
  readonly toggleAll: () => void;
  /** Starts the shared Package lifecycle for the highlighted bundle. */
  readonly startPackage: (target: PackageTarget) => void;
  setMessage(message: ViewMessage | undefined): void;
  setAction(mode: ActionMode): void;
}

type Row = VisibleRow<NodeData>;

/** Space: marks the highlighted Skill for a batch install. */
function markRow(context: CatalogBrowseContext, row: Row): void {
  if (row.node.data.kind !== "skill") {
    context.setMessage({ kind: "error", text: "Mark skills, not source rows" });
    return;
  }
  if (row.node.data.ownedBy !== undefined) {
    context.setMessage({ kind: "error", text: `Package-owned Skills cannot be marked. ${packageOwnedSkillAction(row.node.data.ownedBy)}` });
    return;
  }
  context.setMessage(undefined);
  context.marks.setMarked(toggledMark(context.marks.markedRef.current, row.node.id));
}

/** `a`: marks every listed Skill, or clears the marks when they are all marked already. */
function markAllListed(context: CatalogBrowseContext): void {
  const { markedRef, setMarked } = context.marks;
  const leaves = looseLeavesOf(context.navigation.latestRoots());
  if (leaves.length === 0) {
    context.setMessage({ kind: "error", text: "There are no loose skills to select" });
    return;
  }
  context.setMessage(undefined);
  setMarked(leaves.every((skill) => markedRef.current.has(skillKey(skill))) ? new Set() : new Set(leaves.map(skillKey)));
}

/** `i`: installs the highlighted bundle, or the marked Skills that are listed, or the highlighted one. */
function chooseHosts(context: CatalogBrowseContext, row: Row): void {
  const data = row.node.data;
  // A bundle row is not markable, so it acts on itself and never picks up a Skill mark.
  if (data.kind === "bundle") {
    context.setMessage(undefined);
    context.startPackage({ selection: data.entry.selection, name: data.entry.descriptor.name });
    return;
  }
  // Only what is listed installs: marks on Skills hidden by the filter are ignored.
  const marked = looseLeavesOf(context.navigation.latestRoots())
    .filter((skill) => context.marks.markedRef.current.has(skillKey(skill)));
  if (marked.length === 0 && data.kind === "skill" && data.ownedBy !== undefined) {
    context.setMessage({ kind: "error", text: packageOwnedSkillAction(data.ownedBy) });
    return;
  }
  const highlighted: readonly SkillCandidate[] = data.kind === "skill" ? [data.skill] : [];
  const chosen = marked.length > 0 ? marked : highlighted;
  if (chosen.length === 0) {
    context.setMessage({ kind: "error", text: "Install is not available for source rows; highlight a skill or a Package bundle, or mark some skills with space" });
    return;
  }
  context.setMessage(undefined);
  context.setAction({ kind: "host", skills: chosen, cursor: 0, selected: [] });
}

/** Keys while browsing the Catalog: navigation, filter, marks and starting an install. */
export function handleCatalogBrowseKey(context: CatalogBrowseContext, input: string, key: Key): void {
  const snapshot = context.navigation.latest();
  if (navigateTree(context.navigation, snapshot, context.height, input, key)) return;
  const row = snapshot.visible[snapshot.at];
  if (key.return && row) context.navigation.setExpanded(toggleNode(snapshot.open, row));
  else if (input === "/") context.filter.open();
  else if (key.escape && context.filter.filterRef.current.query !== "") context.filter.clear(context.navigation.restart);
  else if (input === "s" && context.canWiden) context.toggleAll();
  else if (input === " " && row) markRow(context, row);
  else if (input === "a") markAllListed(context);
  else if (input === "i" && context.ready && row) chooseHosts(context, row);
}

