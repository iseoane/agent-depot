/** Central xeo palette for the TUI; views take every colour from here. */
export const theme = {
  /** Panel titles and active labels use Xeo accent pink. */
  title: "#ff2e9a",
  accent: "#ff2e9a",
  /** Borders and group nodes. */
  border: "#7aa2f7",
  group: "#7aa2f7",
  /** Field names and markers such as hosts. */
  field: "#7aa2f7",
  marker: "#7aa2f7",
  /** Primary and emphasized values. */
  text: "#a9b1d6",
  value: "#c0caf5",
  version: "#ff9e64",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  /** Legends, hints and footer. */
  legend: "#565f89",
  muted: "#414868",
  /** Inactive tabs and selected-row background. */
  inactive: "#565f89",
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
