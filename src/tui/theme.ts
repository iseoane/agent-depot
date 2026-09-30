/** Central xeo palette for the TUI; views take every colour from here. */
export const theme = {
  /** Title and active tab. */
  accent: "#ff2e9a",
  /** Group nodes and selection text. */
  group: "#7aa2f7",
  /** Markers such as hosts and versions. */
  marker: "#449dab",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  /** Hints and footer. */
  muted: "#414868",
  /** Inactive tabs. */
  inactive: "#565f89",
  /** Background of the selected row. */
  selection: "#292e42",
} as const;

/** Columns assumed when the terminal width is unknown. */
export const FALLBACK_TERMINAL_COLUMNS = 80;

/** Double-line rule as wide as the terminal. */
export function separatorLine(columns: number | undefined): string {
  const width = columns !== undefined && columns > 0 ? Math.floor(columns) : FALLBACK_TERMINAL_COLUMNS;
  return "═".repeat(width);
}

/** Text props for a list row: bold on the selection background when selected. */
export function rowStyle(selected: boolean): { readonly bold: boolean; readonly backgroundColor?: string } {
  return selected ? { bold: true, backgroundColor: theme.selection } : { bold: false };
}
