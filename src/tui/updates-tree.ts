import type { TreeNode } from "./tree.js";
import type { UpdateRow } from "./updates.js";

/** What an Updates tree node stands for: a group of updatable rows, or one such row. */
export type UpdateNodeData =
  | { readonly kind: "group"; readonly label: string; /** Selection keys of every updatable row below. */ readonly leafKeys: readonly string[] }
  | { readonly kind: "update"; readonly row: UpdateRow };

export type UpdateNode = TreeNode<UpdateNodeData>;

export type CheckState = "all" | "some" | "none";

/** Source groups with Packages and Skills below them, then Apps; built from the updatable rows only. */
export function buildUpdateTree(rows: readonly UpdateRow[]): readonly UpdateNode[] {
  void rows;
  return [];
}

/** Whether all, some or none of a group's rows are selected. */
export function groupCheckState(leafKeys: readonly string[], checked: readonly string[]): CheckState {
  void leafKeys;
  void checked;
  return "none";
}

/** Space on a group: selects all its rows unless they all are, then unselects them; other rows are untouched. */
export function toggleGroup(checked: readonly string[], leafKeys: readonly string[]): readonly string[] {
  void leafKeys;
  return checked;
}

/** A Package row inside its Source group: the bundle name, plus its path only when it is not the Source root. */
export function packageLeafLabel(row: UpdateRow): string {
  void row;
  return "";
}
