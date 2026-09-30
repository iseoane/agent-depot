import type { SkillCandidate } from "../skill-discovery.js";
import { defaultExpanded, type Expanded, type TreeNode, type VisibleRow } from "./tree.js";

const DESCRIPTION_LIMIT = 60;

/** A source group or an installable Skill. */
export type NodeData =
  | { readonly kind: "source"; readonly sourceId: string; readonly count: number }
  | { readonly kind: "skill"; readonly skill: SkillCandidate };

export type CatalogNode = TreeNode<NodeData>;

export const UNMANAGED_MARKER = "on disk, unmanaged · adopt it from Installations";

export const skillKey = (skill: SkillCandidate): string => `skill:${skill.sourceId}:${skill.path}`;

function truncate(text: string): string {
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 3)}...` : text;
}

/** Skills grouped by Source in first-seen order; a Source with no Skills never appears. */
export function buildTree(skills: readonly SkillCandidate[]): readonly CatalogNode[] {
  const bySource = new Map<string, SkillCandidate[]>();
  for (const skill of skills) bySource.set(skill.sourceId, [...(bySource.get(skill.sourceId) ?? []), skill]);
  return [...bySource].map(([sourceId, members]): CatalogNode => ({
    id: `source:${sourceId}`,
    data: { kind: "source", sourceId, count: members.length },
    children: members.map((skill): CatalogNode => ({ id: skillKey(skill), data: { kind: "skill", skill } })),
  }));
}

function allSourceIds(roots: readonly CatalogNode[]): Expanded {
  return new Set(roots.filter((root) => (root.children?.length ?? 0) > 0).map((root) => root.id));
}

/** While a filter is set every matching source is open so the matches show; otherwise only the first. */
export function openByDefault(nodes: readonly CatalogNode[], query: string): Expanded {
  return query === "" ? defaultExpanded(nodes) : allSourceIds(nodes);
}

export function describeRow(row: VisibleRow<NodeData>): string {
  const { data } = row.node;
  if (data.kind === "source") return `${row.expanded ? "▾" : "▸"} ${data.sourceId} (${data.count})`;
  return `${data.skill.name}  ${truncate(data.skill.description)}`;
}

/** The Skills under the tree's Sources, in display order. */
export function leavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return roots.flatMap((root) => (root.children ?? []).flatMap((child) => child.data.kind === "skill" ? [child.data.skill] : []));
}
