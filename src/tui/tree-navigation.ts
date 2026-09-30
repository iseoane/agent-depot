import type { Key } from "ink";
import { useCallback, useRef, useState } from "react";

import {
  collapseOrParent,
  expandNode,
  flattenVisible,
  resolveSelection,
  type Expanded,
  type TreeNode,
  type VisibleRow,
} from "./tree.js";
import { pageStep } from "./window.js";

export interface TreeSelection {
  readonly id?: string;
  readonly index: number;
}

/** Visible rows and the selected index as of the latest keystroke. */
export interface TreeSnapshot<T> {
  readonly open: Expanded;
  readonly visible: readonly VisibleRow<T>[];
  readonly at: number;
}

export interface TreeNavigation<T> {
  /** For rendering. */
  readonly rows: readonly VisibleRow<T>[];
  readonly index: number;
  readonly latest: () => TreeSnapshot<T>;
  /** The whole tree as of the latest render, whether or not its groups are open. */
  readonly latestRoots: () => readonly TreeNode<T>[];
  readonly setExpanded: (next: Expanded | undefined) => void;
  readonly setSelection: (next: TreeSelection) => void;
  /** Top of the list, groups opened by the default rule. */
  readonly restart: () => void;
}

/**
 * Expansion and selection of a tree, mirrored in refs so keys delivered in one
 * burst act on the latest state. `openByDefault` decides which groups are open
 * until the user changes them.
 */
export function useTreeNavigation<T>(
  roots: readonly TreeNode<T>[],
  openByDefault: (roots: readonly TreeNode<T>[]) => Expanded,
): TreeNavigation<T> {
  const [expandedState, setExpandedState] = useState<Expanded | undefined>();
  const expandedRef = useRef<Expanded | undefined>(undefined);
  const [selection, setSelectionState] = useState<TreeSelection>({ index: 0 });
  const selectionRef = useRef<TreeSelection>({ index: 0 });
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const openByDefaultRef = useRef(openByDefault);
  openByDefaultRef.current = openByDefault;

  const setExpanded = useCallback((next: Expanded | undefined) => {
    expandedRef.current = next;
    setExpandedState(next);
  }, []);
  const setSelection = useCallback((next: TreeSelection) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  const restart = useCallback(() => {
    setSelection({ index: 0 });
    setExpanded(undefined);
  }, [setSelection, setExpanded]);

  const rows = flattenVisible(roots, expandedState ?? openByDefault(roots));
  const latest = (): TreeSnapshot<T> => {
    const open = expandedRef.current ?? openByDefaultRef.current(rootsRef.current);
    const visible = flattenVisible(rootsRef.current, open);
    return { open, visible, at: resolveSelection(visible, selectionRef.current) };
  };
  const latestRoots = () => rootsRef.current;
  return { rows, index: resolveSelection(rows, selection), latest, latestRoots, setExpanded, setSelection, restart };
}

/**
 * Up/down, paging and expand/collapse keys shared by the tree views. Returns
 * whether the key was one of them; Enter, space and letters belong to the view.
 */
export function navigateTree<T>(
  navigation: TreeNavigation<T>,
  snapshot: TreeSnapshot<T>,
  height: number,
  input: string,
  key: Key,
): boolean {
  const { open, visible, at } = snapshot;
  const row = visible[at];
  const moveTo = (target: number) => {
    const bounded = Math.min(Math.max(target, 0), Math.max(visible.length - 1, 0));
    navigation.setSelection({ id: visible[bounded]?.node.id, index: bounded });
  };
  if (key.downArrow || input === "j") moveTo(at + 1);
  else if (key.upArrow || input === "k") moveTo(at - 1);
  else if (key.pageDown) moveTo(at + pageStep(height));
  else if (key.pageUp) moveTo(at - pageStep(height));
  else if (key.rightArrow && row) navigation.setExpanded(expandNode(open, row));
  else if (key.leftArrow && row) {
    const next = collapseOrParent(open, visible, at);
    navigation.setExpanded(next.expanded);
    navigation.setSelection({ id: next.selectedId, index: at });
  } else return false;
  return true;
}
