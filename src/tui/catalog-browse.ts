import type { Key } from "ink";

import type { SkillCandidate } from "../skill-discovery.js";
import { type ActionMode } from "./catalog-actions.js";
import { leavesOf, skillKey, type NodeData } from "./catalog-tree.js";
import type { CatalogFilterControls } from "./catalog-state.js";
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
  context.setMessage(undefined);
  context.marks.setMarked(toggledMark(context.marks.markedRef.current, row.node.id));
}

/** `a`: marks every listed Skill, or clears the marks when they are all marked already. */
function markAllListed(context: CatalogBrowseContext): void {
  const { markedRef, setMarked } = context.marks;
  const leaves = leavesOf(context.navigation.latestRoots());
  if (leaves.length === 0) {
    context.setMessage({ kind: "error", text: "There are no skills to select" });
    return;
  }
  context.setMessage(undefined);
  setMarked(leaves.every((skill) => markedRef.current.has(skillKey(skill))) ? new Set() : new Set(leaves.map(skillKey)));
}

/** `i`: installs the marked Skills that are listed, or the highlighted one. */
function chooseHosts(context: CatalogBrowseContext, row: Row): void {
  // Only what is listed installs: marks on Skills hidden by the filter are ignored.
  const marked = leavesOf(context.navigation.latestRoots())
    .filter((skill) => context.marks.markedRef.current.has(skillKey(skill)));
  const highlighted: readonly SkillCandidate[] = row.node.data.kind === "skill" ? [row.node.data.skill] : [];
  const chosen = marked.length > 0 ? marked : highlighted;
  if (chosen.length === 0) {
    context.setMessage({ kind: "error", text: "Install is not available for source rows; highlight a skill or mark some with space" });
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

