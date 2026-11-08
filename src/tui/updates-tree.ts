import { bundleRoot } from "../package-model.js";
import { groupUpdates, type GroupableUpdate } from "../update-groups.js";
import { sourceLabel } from "./installations.js";
import type { TreeNode } from "./tree.js";
import type { UpdateRow } from "./updates.js";

/** What an Updates tree node stands for: a group of updatable rows, or one such row. */
export type UpdateNodeData =
  | { readonly kind: "group"; readonly label: string; /** Selection keys of every updatable row below. */ readonly leafKeys: readonly string[] }
  | { readonly kind: "update"; readonly row: UpdateRow };

export type UpdateNode = TreeNode<UpdateNodeData>;

export type CheckState = "all" | "some" | "none";

type Grouped = GroupableUpdate & { readonly row: UpdateRow };

function grouped(row: UpdateRow): Grouped {
  if (row.kind === "app") return { kind: "app", row };
  const source = row.kind === "skill" ? row.item.selection.source : row.check.installed.selection.source;
  const label = sourceLabel(source);
  return { kind: row.kind, source: { id: label, label }, row };
}

// Node ids stay stable across reloads, and keys and Source labels hold paths and URLs, so they are encoded.
const leaf = (row: UpdateRow): UpdateNode => ({ id: `update:${encodeURIComponent(row.key)}`, data: { kind: "update", row } });

function group(id: string, name: string, leaves: readonly UpdateNode[], children: readonly UpdateNode[] = leaves): UpdateNode {
  const leafKeys = leaves.flatMap((node) => (node.data.kind === "update" ? [node.data.row.key] : node.data.leafKeys));
  return { id, data: { kind: "group", label: `${name} (${leafKeys.length})`, leafKeys }, children };
}

/** Source groups with Packages and Skills below them, then Apps; built from the updatable rows only. */
export function buildUpdateTree(rows: readonly UpdateRow[]): readonly UpdateNode[] {
  const { sources, apps } = groupUpdates(rows.map(grouped));
  const nodes = sources.map(({ source, subgroups }) => {
    const id = `source:${encodeURIComponent(source.id)}`;
    const children = subgroups.map(({ kind, items }) =>
      group(`${id}:${kind}`, kind === "packages" ? "Packages" : "Skills", items.map((item) => leaf(item.row))));
    return group(id, source.label, children);
  });
  if (apps.length > 0) nodes.push(group("apps", "Apps", apps.map((item) => leaf(item.row))));
  return nodes;
}

/** Whether all, some or none of a group's rows are selected. */
export function groupCheckState(leafKeys: readonly string[], checked: readonly string[]): CheckState {
  const count = leafKeys.filter((key) => checked.includes(key)).length;
  if (count === 0) return "none";
  return count === leafKeys.length ? "all" : "some";
}

/** Space on a group: selects all its rows unless they all are, then unselects them; other rows are untouched. */
export function toggleGroup(checked: readonly string[], leafKeys: readonly string[]): readonly string[] {
  if (groupCheckState(leafKeys, checked) === "all") return checked.filter((key) => !leafKeys.includes(key));
  return [...checked, ...leafKeys.filter((key) => !checked.includes(key))];
}

/** A Package row inside its Source group: the bundle name, plus its path only when it is not the Source root. */
export function packageLeafLabel(row: UpdateRow): string {
  if (row.kind !== "package") return row.path;
  const selection = row.check.installed.selection;
  const root = bundleRoot(selection);
  // A Pi bundle has no plugin name, so its directory names it; at the Source root only the host is left.
  const name = selection.host === "claude" ? selection.pluginName : root.split("/").pop() || "pi package";
  return `Package: ${name}${root === "" ? "" : `  ${root}`}`;
}
