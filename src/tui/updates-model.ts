import type { UpdateRow, UpdateScopeFilter, UpdatesData, UpdatesPhase } from "./updates.js";

export const REFRESHING = "Refreshing sources...";
export const CHECKING = "Checking for updates...";
export const PHASE_LABEL: Record<UpdatesPhase, string> = { refreshing: REFRESHING, checking: CHECKING };

/** The result lines shown under the list. */
export interface UpdatesMessage {
  readonly kind: "ok" | "error";
  readonly lines: readonly string[];
}

export type LoadState =
  | { readonly status: "loading"; readonly label: string }
  | { readonly status: "ready"; readonly data: UpdatesData };

/** A line the cursor can be on: an updatable item, the fold of unassessable ones, or one of those when unfolded. */
export type Entry =
  | { readonly kind: "update"; readonly row: UpdateRow }
  | { readonly kind: "summary" }
  | { readonly kind: "unknown"; readonly row: UpdateRow };

/** Names the reasons worth knowing before expanding the collapsed "cannot be checked" row. */
export function describeUnknownReasons(rows: readonly UpdateRow[]): string {
  const newer = rows.filter((row) => /^installed by a newer agent depot/i.test(row.reason)).length;
  const pinned = rows.filter((row) => /^pinned to agent depot/i.test(row.reason)).length;
  const parts = [
    ...(newer > 0 ? [`${newer} installed by a newer Agent Depot`] : []),
    ...(pinned > 0 ? [`${pinned} pinned to another Agent Depot`] : []),
  ];
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

const matchesScope = (row: UpdateRow, filter: UpdateScopeFilter): boolean => filter === "all" || row.scope === filter;

/** The rows the list shows for a scope filter and fold state, and the cursor positions they make up. */
export function viewOf(data: UpdatesData | undefined, scope: UpdateScopeFilter, showUnknown: boolean) {
  const shown = (data?.rows ?? []).filter((row) => matchesScope(row, scope));
  const updatable = shown.filter((row) => row.item.status === "updateable");
  const unknown = shown.filter((row) => row.item.status === "unknown");
  const upToDate = shown.filter((row) => row.item.status === "current").length;
  const entries: readonly Entry[] = [
    ...updatable.map((row): Entry => ({ kind: "update", row })),
    ...(unknown.length > 0 ? [{ kind: "summary" } as const] : []),
    ...(unknown.length > 0 && showUnknown ? unknown.map((row): Entry => ({ kind: "unknown", row })) : []),
  ];
  return { shown, updatable, unknown, upToDate, entries };
}

export type UpdatesListView = ReturnType<typeof viewOf>;

export function describeRefresh(data: UpdatesData): string {
  const { attempted, refreshed, failed, unreadable } = data.refresh;
  if (!attempted) return "sources not fetched again";
  if (unreadable.length > 0) {
    return `could not refresh: ${unreadable.map(({ scope, reason }) => `${reason} (${scope})`).join("; ")}; cached data was used`;
  }
  if (failed.length > 0) {
    return `${failed.length} of ${failed.length + refreshed.length} sources could not be refreshed; their current data was used`;
  }
  return refreshed.length > 0 ? "sources refreshed" : "no Git sources to refresh";
}

/** Data for a check that failed as a whole, so the view can show the reason. */
export function emptyData(reason: string, checkedAt: number): UpdatesData {
  return {
    results: [{ scope: "project", error: reason }],
    rows: [],
    refresh: { attempted: false, refreshed: [], failed: [], unreadable: [] },
    checkedAt,
  };
}
