import type { SkillCandidate } from "../skill-discovery.js";
import type { Source } from "../sources.js";
import { githubTreeLocation } from "../git-source.js";
import { defaultExpanded, type Expanded, type TreeNode, type VisibleRow } from "./tree.js";

const DESCRIPTION_LIMIT = 60;

/** A source group or an installable Skill. */
export type NodeData =
  | { readonly kind: "source"; readonly sourceId: string; readonly label: string; readonly count: number }
  | { readonly kind: "skill"; readonly skill: SkillCandidate };

export type CatalogNode = TreeNode<NodeData>;

export const UNMANAGED_MARKER = "on disk, unmanaged · adopt it from Installations";

export const skillKey = (skill: SkillCandidate): string => `skill:${skill.sourceId}:${skill.path}`;

function truncate(text: string): string {
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 3)}...` : text;
}

/** A repository name, with directory and ref for scoped GitHub Sources. */
export function sourceLabel(source: Source): string {
  if (source.kind === "builtin") return source.id;
  const location = githubTreeLocation(source.url);
  if (location !== undefined) {
    return `${location.repository}${location.directory === undefined ? "" : ` · ${location.directory}`} @ ${location.ref}`;
  }
  const url = new URL(source.url);
  const repository = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  return url.hostname === "github.com" ? repository : `${url.host}/${repository}`;
}

/** Skills grouped by Source in first-seen order; a Source with no Skills never appears. */
export function buildTree(skills: readonly SkillCandidate[], sources: readonly Source[] = []): readonly CatalogNode[] {
  const labels = new Map(sources.map((source) => [source.id, sourceLabel(source)]));
  const bySource = new Map<string, SkillCandidate[]>();
  for (const skill of skills) bySource.set(skill.sourceId, [...(bySource.get(skill.sourceId) ?? []), skill]);
  return [...bySource].map(([sourceId, members]): CatalogNode => ({
    id: `source:${sourceId}`,
    data: { kind: "source", sourceId, label: labels.get(sourceId) ?? sourceId, count: members.length },
    children: members.map((skill): CatalogNode => ({ id: skillKey(skill), data: { kind: "skill", skill } })),
  }));
}

function allSourceIds(roots: readonly CatalogNode[]): Expanded {
  return new Set(roots.filter((root) => (root.children?.length ?? 0) > 0).map((root) => root.id));
}

/** Filtering opens matching Sources; otherwise all groups start collapsed. */
export function openByDefault(nodes: readonly CatalogNode[], query: string): Expanded {
  return query === "" ? defaultExpanded() : allSourceIds(nodes);
}

export function describeRow(row: VisibleRow<NodeData>): string {
  const { data } = row.node;
  if (data.kind === "source") return `${row.expanded ? "▾" : "▸"} ${data.label} (${data.count})`;
  return `${data.skill.name}  ${truncate(data.skill.description)}`;
}

/** The Skills under the tree's Sources, in display order. */
export function leavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return roots.flatMap((root) => (root.children ?? []).flatMap((child) => child.data.kind === "skill" ? [child.data.skill] : []));
}
