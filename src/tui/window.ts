import { useStdout } from "ink";

/** Rows assumed when the terminal size is unknown (for example under test renderers). */
export const FALLBACK_TERMINAL_ROWS = 24;
/** Lines the shell itself uses: title, tab bar and footer hint. */
export const APP_CHROME_ROWS = 3;
const MINIMUM_ROWS = 3;

export interface ListWindow {
  /** Index of the first rendered row. */
  readonly start: number;
  /** Index one past the last rendered row. */
  readonly end: number;
  /** `12–30 of 84`, only when the list does not fit. */
  readonly indicator: string | undefined;
}

/** The slice of a list that fits in `height` rows while keeping `selected` visible (roughly centred). */
export function computeWindow(total: number, selected: number, height: number): ListWindow {
  const size = Math.max(Math.floor(height), 1);
  if (total <= size) return { start: 0, end: total, indicator: undefined };
  const bounded = Math.min(Math.max(selected, 0), total - 1);
  const start = Math.min(Math.max(bounded - Math.floor(size / 2), 0), total - size);
  const end = start + size;
  return { start, end, indicator: `${start + 1}–${end} of ${total}` };
}

/** How far PgUp/PgDn move the selection. */
export function pageStep(height: number): number {
  return Math.max(Math.floor(height), 1);
}

/**
 * Rows available to a list: the terminal height minus the shell chrome and the
 * view's own `reserved` lines. `override` fixes the height for tests.
 */
export function useListHeight(override: number | undefined, reserved: number): number {
  const { stdout } = useStdout();
  if (override !== undefined) return Math.max(override, 1);
  const rows = stdout.rows ?? FALLBACK_TERMINAL_ROWS;
  return Math.max(rows - APP_CHROME_ROWS - reserved, MINIMUM_ROWS);
}
