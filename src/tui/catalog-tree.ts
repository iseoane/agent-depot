import type { SkillCandidate } from "../skill-discovery.js";
import type { Source } from "../sources.js";
import { githubTreeLocation } from "../git-source.js";
import { bundleRoot, type BundleDescriptor, type PackageSelection } from "../package-model.js";
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
  | { readonly kind: "skill"; readonly skill: SkillCandidate; readonly ownedBy?: BundleDescriptor };

export type CatalogNode = TreeNode<NodeData>;

export const UNMANAGED_MARKER = "on disk, unmanaged · adopt it from Installations";

export const skillKey = (skill: SkillCandidate): string => `skill:${skill.sourceId}:${skill.path}`;

export const bundleKey = (entry: BundleEntry): string =>
  `bundle:${entry.sourceId}:${entry.descriptor.host}:${bundleRoot(entry.descriptor.coordinates)}`;

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
): readonly CatalogNode[] {
  const labels = new Map(sources.map((source) => [source.id, sourceLabel(source)]));
  const active = new Set(activeDescriptors);
  const bySource = new Map<string, SkillCandidate[]>();
  for (const skill of skills) bySource.set(skill.sourceId, [...(bySource.get(skill.sourceId) ?? []), skill]);
  const bundlesBySource = new Map<string, BundleEntry[]>();
  for (const bundle of bundles) bundlesBySource.set(bundle.sourceId, [...(bundlesBySource.get(bundle.sourceId) ?? []), bundle]);
  return [...new Set([...bySource.keys(), ...bundlesBySource.keys()])].map((sourceId): CatalogNode => {
    const members = bySource.get(sourceId) ?? [];
    const sourceBundles = bundlesBySource.get(sourceId) ?? [];
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
        ...members.map((skill): CatalogNode => {
          const ownedBy = owned(skill.path);
          return { id: skillKey(skill), data: { kind: "skill", skill, ...(ownedBy === undefined ? {} : { ownedBy }) } };
        }),
      ],
    };
  });
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
  if (data.kind === "group") return `${row.expanded ? "▾" : "▸"} ${data.label}`;
  if (data.kind === "bundle") {
    return `Package ${data.entry.descriptor.name} (${data.entry.descriptor.host})  ${packageVersionLabel(data.entry.descriptor.version)}`;
  }
  return `${data.skill.name}  ${truncateDescription(data.skill.description)}`;
}

/** The Skills under the tree's Sources, in display order. */
export function leavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return roots.flatMap((root) => (root.children ?? []).flatMap((child) => child.data.kind === "skill" ? [child.data.skill] : []));
}

/** Skills that can still be installed as loose Skills, excluding active Package-owned rows. */
export function looseLeavesOf(roots: readonly CatalogNode[]): readonly SkillCandidate[] {
  return roots.flatMap((root) => (root.children ?? []).flatMap((child) =>
    child.data.kind === "skill" && child.data.ownedBy === undefined ? [child.data.skill] : [],
  ));
}
