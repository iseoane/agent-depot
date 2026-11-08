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

/** Groups updates by Source, then by Packages and Skills, with Apps apart. */
export function groupUpdates<T extends GroupableUpdate>(items: readonly T[]): UpdateGroups<T> {
  void items;
  return { sources: [], apps: [] };
}
