import type { BulkTarget } from "./bulk-actions.js";
import type { AppRow, InstallationRow, InstallationsData, UnmanagedGroup } from "./installations.js";
import type { TreeNode, VisibleRow } from "./tree.js";

/** What a tree node stands for: a scope or source group, a managed installation or an unmanaged Skill. */
export type NodeData =
  | { readonly kind: "group"; readonly label: string }
  | { readonly kind: "installation"; readonly row: InstallationRow }
  | { readonly kind: "app"; readonly row: AppRow }
  | { readonly kind: "unmanaged"; readonly group: UnmanagedGroup };

export type InstallationNode = TreeNode<NodeData>;

/** Managed installations of one scope, grouped by Source in first-seen order. */
function sourceNodes(scope: InstallationRow["scope"], rows: readonly InstallationRow[]): readonly InstallationNode[] {
  const bySource = new Map<string, InstallationRow[]>();
  for (const row of rows) bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
  return [...bySource].map(([source, members]): InstallationNode => ({
    id: `source:${scope}:${source}`,
    data: { kind: "group", label: `${source} (${members.length})` },
    children: members.map((row): InstallationNode => ({
      id: `installation:${scope}:${source}:${row.selection.installation?.path ?? row.selection.path}`,
      data: { kind: "installation", row },
    })),
  }));
}

/** Scope, then Source, then Skills; Unmanaged is its own group. Counts come from data already loaded. */
export function buildTree(data: InstallationsData): readonly InstallationNode[] {
  const roots: InstallationNode[] = [];
  if (data.global !== undefined) {
    roots.push({
      id: "scope:user-global",
      data: { kind: "group", label: `Managed (user-global) (${data.global.length})` },
      children: sourceNodes("user-global", data.global),
    });
  }
  roots.push({
    id: "scope:project",
    data: { kind: "group", label: `Managed (project) (${data.project.length})` },
    children: sourceNodes("project", data.project),
  });
  roots.push({
    id: "scope:unmanaged",
    data: { kind: "group", label: `Unmanaged (user-global) (${data.unmanaged.length})${data.unmanagedWarnings?.length ? ` — ${data.unmanagedWarnings.join("; ")}` : ""}` },
    children: data.unmanaged.map((group): InstallationNode => ({ id: `unmanaged:${group.name}`, data: { kind: "unmanaged", group } })),
  });
  if (data.apps?.length || data.appsError) roots.push({
    id: "scope:apps", data: { kind: "group", label: `Apps (user-global) (${data.apps?.length ?? 0})${data.appsError ? ` — ${data.appsError}` : ""}` },
    children: (data.apps ?? []).map(row => ({ id: `app:${row.entry.file}`, data: { kind: "app", row } })),
  });
  return roots;
}

/** Version, policy and hosts of a leaf; `adopted` / `modified` only when true (the legend explains them). */
export function describeDetails({ selection, policy, installed }: InstallationRow): string {
  return `${installed} (${policy})  [${selection.hosts.join(", ")}]`;
}

export function markersOf({ adopted, modified }: InstallationRow): string {
  return [adopted ? "adopted" : "", modified ? "modified" : ""].filter((flag) => flag !== "").join(" ");
}

/** Every leaf of the tree in display order, whether or not its group is open. */
export function leavesOf(roots: readonly InstallationNode[]): readonly InstallationNode[] {
  return roots.flatMap((node) => (node.children === undefined ? (node.data.kind === "group" ? [] : [node]) : leavesOf(node.children)));
}

export function targetOf(node: InstallationNode): BulkTarget | undefined {
  const { data } = node;
  if (data.kind === "installation") return { id: node.id, leaf: { kind: "installation", row: data.row } };
  if (data.kind === "unmanaged") return { id: node.id, leaf: { kind: "unmanaged", group: data.group } };
  return undefined;
}

export function describeNode(row: VisibleRow<NodeData>): string {
  const { data } = row.node;
  if (data.kind === "group") return `${row.expandable ? (row.expanded ? "▾" : "▸") : " "} ${data.label}`;
  if (data.kind === "installation") return data.row.selection.path;
  if (data.kind === "app") {
    const { entry, inspection } = data.row;
    return `${entry.recipe?.name ?? entry.file}  ${inspection.status === "invalid" ? `invalid recipe: ${inspection.reason}` : inspection.installedVersion ?? inspection.status}`;
  }
  return `${data.group.name} [${data.group.hosts.join(", ")}]`;
}

/** `symlink → <target>` for the locations that are links, one entry per distinct target. */
export function describeLinks(group: UnmanagedGroup): string {
  const targets = [...new Set(group.locations.flatMap((location) => location.linkTarget === undefined ? [] : [location.linkTarget]))];
  return targets.length === 0 ? "" : `symlink → ${targets.join(", ")}`;
}
