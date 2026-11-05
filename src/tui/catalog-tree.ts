import type { SkillCandidate } from "../skill-discovery.js";
import type { CatalogAppRow } from "./catalog-state.js";
import type { Source } from "../sources.js";
import { githubTreeLocation } from "../git-source.js";
import { selectionKey, type BundleDescriptor, type PackageSelection } from "../package-model.js";
import { packageOwnedSkillMatcher } from "../package-owned-skills.js";
import { packageVersionLabel } from "./package-rows.js";
import { defaultExpanded, type Expanded, type TreeNode, type VisibleRow } from "./tree.js";

const DESCRIPTION_LIMIT = 60;

/** A bundle of one Source, as the Catalog groups it under that Source. */
export interface BundleEntry {
  readonly sourceId: string;
  /** The portable selection the Package lifecycle takes: the descriptor's coordinates, `latest`, and the registered Source. */
  readonly selection: PackageSelection;
  readonly descriptor: BundleDescriptor;
}

/** A Source, a Packages group, a bundle or an installable Skill. */
export type NodeData =
  | { readonly kind: "source"; readonly sourceId: string; readonly label: string; readonly count: number }
  | { readonly kind: "group"; readonly label: string }
  | { readonly kind: "bundle"; readonly entry: BundleEntry }
  | { readonly kind: "skill"; readonly skill: SkillCandidate; readonly ownedBy?: BundleDescriptor; /** A variant of a same-named group, so the row names its path. */ readonly variant?: boolean }
  | { readonly kind: "app"; readonly row: CatalogAppRow };

export type CatalogNode = TreeNode<NodeData>;

export const UNMANAGED_MARKER = "on disk, unmanaged · adopt it from Installations";

export const skillKey = (skill: SkillCandidate): string => `skill:${skill.sourceId}:${skill.path}`;

/** Keyed on the full selection, so two plugins of one marketplace root stay distinct nodes. */
export const bundleKey = (entry: BundleEntry): string => `bundle:${entry.sourceId}:${selectionKey(entry.selection)}`;

export function truncateDescription(text: string): string {
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

/** Skills and their Source's Packages, in first-seen order; a Source with neither never appears. */
export function buildTree(
  skills: readonly SkillCandidate[],
  sources: readonly Source[] = [],
  bundles: readonly BundleEntry[] = [],
  activeDescriptors: readonly BundleDescriptor[] = [],
  apps: readonly CatalogAppRow[] = [],
): readonly CatalogNode[] {
  const labels = new Map(sources.map((source) => [source.id, sourceLabel(source)]));
  const active = new Set(activeDescriptors);
  const bySource = new Map<string, SkillCandidate[]>();
  for (const skill of skills) bySource.set(skill.sourceId, [...(bySource.get(skill.sourceId) ?? []), skill]);
  const bundlesBySource = new Map<string, BundleEntry[]>();
  const seenBundles = new Set<string>();
  for (const bundle of bundles) {
    // Descriptors with identical coordinates are one Package; a duplicate node id would corrupt the rows.
    if (seenBundles.has(bundleKey(bundle))) continue;
    seenBundles.add(bundleKey(bundle));
    bundlesBySource.set(bundle.sourceId, [...(bundlesBySource.get(bundle.sourceId) ?? []), bundle]);
  }
  const sourcesTree = [...new Set([...bySource.keys(), ...bundlesBySource.keys()])].map((sourceId): CatalogNode => {
    const members = bySource.get(sourceId) ?? [];
    const sourceBundles = bundlesBySource.get(sourceId) ?? [];
    const variants = new Map<string, SkillCandidate[]>();
    for (const skill of members) variants.set(skill.name, [...(variants.get(skill.name) ?? []), skill]);
    const owned = packageOwnedSkillMatcher(sourceBundles.map((entry) => entry.descriptor).filter((descriptor) => active.has(descriptor)));
    return {
      id: `source:${sourceId}`,
      data: { kind: "source", sourceId, label: labels.get(sourceId) ?? sourceId, count: members.length },
      children: [
        ...(sourceBundles.length === 0 ? [] : [{
          id: `packages:${sourceId}`,
          data: { kind: "group" as const, label: `Packages (${sourceBundles.length})` },
          children: sourceBundles.map((entry): CatalogNode => ({ id: bundleKey(entry), data: { kind: "bundle", entry } })),
        }]),
        ...[...variants.values()].map((group): CatalogNode => {
          const variant = group.length > 1;
          const nodes = group.map((skill): CatalogNode => {
            const ownedBy = owned(skill.path);
            return { id: skillKey(skill), data: { kind: "skill", skill, ...(ownedBy === undefined ? {} : { ownedBy }), ...(variant ? { variant } : {}) } };
          });
          // Same-named Skills of one Source differ in content, so each stays its own installable row under one group.
          return variant
            ? { id: `variants:${sourceId}:${group[0]!.name}`, data: { kind: "group", label: `${group[0]!.name} (${group.length} variants)` }, children: nodes }
            : nodes[0]!;
        }),
      ],
    };
  });
  return apps.length === 0 ? sourcesTree : [...sourcesTree, {
    id: "apps:user-global",
    data: { kind: "group", label: `Apps (user-global) (${apps.length})` },
    children: apps.map((row): CatalogNode => ({ id: `app:${row.entry.file}`, data: { kind: "app", row } })),
  }];
}

function allExpandableIds(roots: readonly CatalogNode[]): Expanded {
  const ids = new Set<string>();
  const visit = (nodes: readonly CatalogNode[]) => {
    for (const node of nodes) {
      if ((node.children?.length ?? 0) === 0) continue;
      ids.add(node.id);
      visit(node.children!);
    }
  };
  visit(roots);
  return ids;
}

/** Filtering opens matching Sources; otherwise all groups start collapsed. */
export function openByDefault(nodes: readonly CatalogNode[], query: string): Expanded {
  return query === "" ? defaultExpanded() : allExpandableIds(nodes);
}

export function describeRow(row: VisibleRow<NodeData>): string {
  const { data } = row.node;
  if (data.kind === "source") return `${row.expanded ? "▾" : "▸"} ${data.label} (${data.count})`;
  if (data.kind === "group") return `${row.expanded ? "▾" : "▸"} ${data.label}`;
  if (data.kind === "bundle") {
    return `Package ${data.entry.descriptor.name} (${data.entry.descriptor.host})  ${packageVersionLabel(data.entry.descriptor.version)}`;
  }
  if (data.kind === "app") return `App ${data.row.entry.recipe?.name ?? data.row.entry.file}  ${data.row.inspection.status}`;
  return `${data.skill.name}  ${truncateDescription(data.skill.description)}${data.variant === true ? `  (${data.skill.path})` : ""}`;
}

/** Skill nodes directly under a Source or inside one of its variant groups. */
function skillNodesOf(roots: readonly CatalogNode[]): readonly (CatalogNode & { readonly data: Extract<NodeData, { kind: "skill" }> })[] {
  const found: (CatalogNode & { readonly data: Extract<NodeData, { kind: "skill" }> })[] = [];
  const visit = (node: CatalogNode) => {
    if (node.data.kind === "skill") found.push(node as CatalogNode & { readonly data: Extract<NodeData, { kind: "skill" }> });
    else if (node.id.startsWith("variants:")) node.children?.forEach(visit);
  };
  for (const root of roots) root.children?.forEach(visit);
  return found;
}

/** The Skills under the tree's Sources, in display order. */
export function leavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return skillNodesOf(roots).map((node) => node.data.skill);
}

/** Skills that can still be installed as loose Skills, excluding active Package-owned rows. */
export function looseLeavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return skillNodesOf(roots).filter((node) => node.data.ownedBy === undefined).map((node) => node.data.skill);
}
