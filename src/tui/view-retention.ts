import type { InstallationsData } from "./installations.js";
import type { CatalogAppsState, LoadState } from "./catalog-state.js";
import type { InstalledSkills } from "./catalog-installs.js";

/**
 * The last data the Catalog and Installations views loaded, kept above the views because they
 * unmount on every tab change. It is display-only: a revisit shows it while the view reloads, and
 * no mutation preview or confirmation ever reads it.
 */
export interface ViewRetention {
  installations?: InstallationsData;
  /** Skills of one Catalog scope; `catalogKey` says which. */
  catalogKey?: string;
  catalogSkills?: Extract<LoadState, { status: "ready" }>;
  catalogApps?: Extract<CatalogAppsState, { status: "ready" }>;
  installed?: InstalledSkills;
  /** Changes with every invalidation, so a load that began earlier is not kept. */
  generation: number;
}

export function createViewRetention(): ViewRetention {
  return { generation: 0 };
}

/**
 * Drops everything kept. Call after any change to Sources, recipes, approvals or installed
 * state, so a loaded-before-the-change result that finishes later is not kept either.
 */
export function invalidateRetention(retention: ViewRetention | undefined): void {
  if (!retention) return;
  retention.generation += 1;
  retention.installations = undefined;
  retention.catalogKey = undefined;
  retention.catalogSkills = undefined;
  retention.catalogApps = undefined;
  retention.installed = undefined;
}
