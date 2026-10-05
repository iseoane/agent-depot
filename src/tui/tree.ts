/** A node of a collapsible tree; `id` is stable across reloads so selection can follow it. */
export interface TreeNode<T> {
  readonly id: string;
  readonly data: T;
  readonly children?: readonly TreeNode<T>[];
}

/** A node as it appears in the flattened list of visible lines. */
export interface VisibleRow<T> {
  readonly node: TreeNode<T>;
  readonly depth: number;
  readonly parentId: string | undefined;
  /** The node has children, so it can be expanded or collapsed. */
  readonly expandable: boolean;
  readonly expanded: boolean;
}

export type Expanded = ReadonlySet<string>;

/** Every group starts collapsed until the user expands it. */
export function defaultExpanded(): Expanded {
  return new Set();
}

/** The visible nodes in display order: children appear only under expanded parents. */
export function flattenVisible<T>(roots: readonly TreeNode<T>[], expanded: Expanded): VisibleRow<T>[] {
  const rows: VisibleRow<T>[] = [];
  const visit = (nodes: readonly TreeNode<T>[], depth: number, parentId: string | undefined) => {
    for (const node of nodes) {
      const expandable = (node.children?.length ?? 0) > 0;
      const open = expandable && expanded.has(node.id);
      rows.push({ node, depth, parentId, expandable, expanded: open });
      if (open) visit(node.children!, depth + 1, node.id);
    }
  };
  visit(roots, 0, undefined);
  return rows;
}

/** Expands the node; returns the same set when the node is a leaf or already open. */
export function expandNode<T>(expanded: Expanded, row: VisibleRow<T>): Expanded {
  if (!row.expandable || row.expanded) return expanded;
  return new Set(expanded).add(row.node.id);
}

/** Expands a collapsed node and collapses an expanded one; leaves are unchanged. */
export function toggleNode<T>(expanded: Expanded, row: VisibleRow<T>): Expanded {
  if (!row.expandable) return expanded;
  const next = new Set(expanded);
  if (row.expanded) next.delete(row.node.id);
  else next.add(row.node.id);
  return next;
}

/** Left arrow: collapse an open node, otherwise select its parent (a top-level node stays selected). */
export function collapseOrParent<T>(
  expanded: Expanded,
  rows: readonly VisibleRow<T>[],
  index: number,
): { readonly expanded: Expanded; readonly selectedId: string | undefined } {
  const row = rows[index];
  if (!row) return { expanded, selectedId: undefined };
  if (row.expanded) return { expanded: toggleNode(expanded, row), selectedId: row.node.id };
  return { expanded, selectedId: row.parentId ?? row.node.id };
}

/** Index of the selected row: by stable id when still visible, otherwise the bounded fallback index. */
export function resolveSelection<T>(
  rows: readonly VisibleRow<T>[],
  selection: { readonly id?: string; readonly index: number },
): number {
  const found = rows.findIndex((row) => row.node.id === selection.id);
  if (found >= 0) return found;
  return Math.min(Math.max(selection.index, 0), Math.max(rows.length - 1, 0));
}
