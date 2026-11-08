/** Where an item came from: a stable id and the label shown for it. */
export interface SourceRef {
  readonly id: string;
  readonly label: string;
}

/** What grouping needs to know about an update: its kind and, except for Apps, its Source. */
export type GroupableUpdate =
  | { readonly kind: "app" }
  | { readonly kind: "skill" | "package"; readonly source: SourceRef };

export interface SubGroup<T> {
  readonly kind: "packages" | "skills";
  readonly items: readonly T[];
}

export interface SourceGroup<T> {
  readonly source: SourceRef;
  /** Packages first, then Skills; a kind with no items is omitted. */
  readonly subgroups: readonly SubGroup<T>[];
}

export interface UpdateGroups<T> {
  readonly sources: readonly SourceGroup<T>[];
  readonly apps: readonly T[];
}

// Code-unit order, so Linux and Windows agree whatever the locale.
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Groups updates by Source, then by Packages and Skills, with Apps apart. */
export function groupUpdates<T extends GroupableUpdate>(items: readonly T[]): UpdateGroups<T> {
  const bySource = new Map<string, { source: SourceRef; packages: T[]; skills: T[] }>();
  const apps: T[] = [];
  for (const item of items) {
    if (item.kind === "app") {
      apps.push(item);
      continue;
    }
    let group = bySource.get(item.source.id);
    if (group === undefined) {
      group = { source: item.source, packages: [], skills: [] };
      bySource.set(item.source.id, group);
    }
    (item.kind === "package" ? group.packages : group.skills).push(item);
  }
  const sources = [...bySource.values()]
    .sort((left, right) => compare(left.source.label, right.source.label) || compare(left.source.id, right.source.id))
    .map(({ source, packages, skills }): SourceGroup<T> => ({
      source,
      subgroups: [
        ...(packages.length > 0 ? [{ kind: "packages" as const, items: packages }] : []),
        ...(skills.length > 0 ? [{ kind: "skills" as const, items: skills }] : []),
      ],
    }));
  return { sources, apps };
}
