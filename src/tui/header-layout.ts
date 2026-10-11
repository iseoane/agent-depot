export type ViewName = "sources" | "catalog" | "installations" | "updates" | "profile";

export const TABS: readonly (readonly [ViewName, string])[] = [
  ["sources", "[1] Sources"],
  ["catalog", "[2] Catalog"],
  ["installations", "[3] Installations"],
  ["updates", "[4] Updates"],
  ["profile", "[5] Profile"],
];

function tabRowsFor(width: number): readonly (readonly (readonly [ViewName, string])[])[] {
  const rows: (readonly [ViewName, string])[][] = [];
  let row: (readonly [ViewName, string])[] = [];
  let rowWidth = 0;
  for (const tab of TABS) {
    const separatorWidth = row.length === 0 ? 0 : 2;
    // Each rendered row has at most one active marker, regardless of tab count.
    const nextWidth = rowWidth + separatorWidth + tab[1].length;
    if (row.length > 0 && nextWidth + 2 > width) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    rowWidth += (row.length === 0 ? 0 : 2) + tab[1].length;
    row.push(tab);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export function headerTabRowCount(width: number): number {
  return tabRowsFor(width).length;
}

export function formatHeaderTabs(view: ViewName, width: number): string {
  return tabRowsFor(width).map(row => row.map(([name, label]) => `${view === name ? "▶ " : ""}${label}`).join("  ")).join("\n");
}
