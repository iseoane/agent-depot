import { useWindowSize } from "ink";
import stringWidth from "string-width";

import { headerTabRowCount } from "./header-layout.js";
import { ESCAPE_TEXT, namesEscapedCharacter, textUnits, UNSAFE_PATTERN } from "./text-wrap.js";

export interface PreviewChrome {
  readonly title: string;
  /** What `y` does, named in the footer; without it the preview only closes. */
  readonly action?: string;
  /** Shown after `read ✓` once the whole preview has been displayed. */
  readonly consequence?: string;
  /** The key and label that leave without acting. */
  readonly cancel?: string;
  /** Rows rendered by the parent view above the panel. */
  readonly reservedRows?: number;
}

export type PreviewFooterRole = "reading" | "read" | "position" | "consequence" | "yes" | "no" | "action" | "cancel";

export interface PreviewFooterSpan {
  readonly text: string;
  readonly role: PreviewFooterRole;
}

export interface PreviewViewport {
  /**
   * The escaped title as the rows to draw, one per row so the panel cannot wrap it differently from this layout. A title that would
   * leave no row for content or for the footer is cut with an ellipsis.
   */
  readonly titleRows: readonly string[];
  readonly rows: readonly string[];
  /** Source line index for each physically wrapped row. */
  readonly sourceLines: readonly number[];
  /** UTF-16 offset of each physical row within its logical source line, not counting the hanging prefix. */
  readonly sourceOffsets: readonly number[];
  /** UTF-16 length of the hanging prefix that starts each continuation row (0 for the first row of a line). */
  readonly prefixLengths: readonly number[];
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly cursor: number;
  readonly height: number;
  readonly reachedEnd: boolean;
  /** Physical footer rows: reading progress, then what `y` does, wrapped to the preview width. */
  readonly footer: readonly (readonly PreviewFooterSpan[])[];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Text shown in the TUI comes from recipes, Sources, Skills and Hosts. Raw, an ESC or carriage return redraws the terminal over the
// lines under review and a bidi override reorders them; both also change the width the `y` gate was computed for. The zero-width joiner
// stays because emoji sequences such as a person at a laptop are made with it.
// A backslash run before text shaped like an escape we print (`\x1b`, `\u202e`, `\u{1f600}`), or before a character we escape.
const ESCAPABLE = new RegExp(`(\\\\+)(?:(${ESCAPE_TEXT})|(?=${UNSAFE_PATTERN}))|${UNSAFE_PATTERN}`, "giu");

/**
 * `text` with control, format and line-separator characters replaced by visible escapes (`\x1b`, `\u202e`). A backslash run right
 * before text that looks like one of those escapes is doubled, so a typed `\x1b` cannot pass for a real ESC; other backslashes,
 * such as those of a Windows path, are left alone. Not idempotent: escape text once, where it enters a view.
 */
export function escapeControlText(text: string): string {
  return text.replace(ESCAPABLE, (match, backslashes: string | undefined, typed: string | undefined) => {
    if (backslashes !== undefined) {
      return typed !== undefined && !namesEscapedCharacter(typed) ? match : backslashes.repeat(2) + (typed ?? "");
    }
    const code = match.codePointAt(0)!;
    const hex = code.toString(16);
    if (code <= 0xff) return `\\x${hex.padStart(2, "0")}`;
    return code <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
  });
}

function escapeChrome(chrome: PreviewChrome): PreviewChrome {
  return {
    ...chrome,
    title: escapeControlText(chrome.title),
    ...(chrome.action === undefined ? {} : { action: escapeControlText(chrome.action) }),
    ...(chrome.consequence === undefined ? {} : { consequence: escapeControlText(chrome.consequence) }),
    ...(chrome.cancel === undefined ? {} : { cancel: escapeControlText(chrome.cancel) }),
  };
}

interface WrappedRow {
  /** The row as drawn: the hanging prefix, for a continuation row, then its part of the line. */
  readonly row: string;
  /** Offset of the row's text within the line. */
  readonly offset: number;
  readonly prefixLength: number;
}

const TREE_GUTTER = /^( *)([│┌├└])?( *)/u;

/**
 * What continuation rows of a wrapped line start with: its indent and, in a step tree, the gutter that
 * keeps running below its branch (`│` under `┌` and `├`, nothing under `└`). Empty when the prefix would
 * leave less than half the width for text.
 */
function hangingPrefix(line: string, width: number): string {
  const [, before = "", glyph = "", after = ""] = TREE_GUTTER.exec(line) ?? [];
  const continued = glyph === "" ? "" : glyph === "└" ? " " : "│";
  const prefix = `${before}${continued}${after}`;
  return stringWidth(prefix) * 2 <= width ? prefix : "";
}

function wrapLine(line: string, width: number, hang = false): WrappedRow[] {
  const segments = textUnits(line, width);
  if (segments.length === 0) return [{ row: "", offset: 0, prefixLength: 0 }];
  const prefix = hang ? hangingPrefix(line, width) : "";
  const wrapped: WrappedRow[] = [];
  let row = "";
  let rowWidth = 0;
  let rowOffset = 0;
  let prefixLength = 0;
  let hasText = false;
  for (const { segment, index } of segments) {
    const segmentWidth = stringWidth(segment);
    if (hasText && rowWidth + segmentWidth > width) {
      wrapped.push({ row, offset: rowOffset, prefixLength });
      row = prefix;
      rowWidth = stringWidth(prefix);
      prefixLength = prefix.length;
      hasText = false;
      rowOffset = index;
    }
    row += segment;
    rowWidth += segmentWidth;
    hasText = true;
  }
  wrapped.push({ row, offset: rowOffset, prefixLength });
  return wrapped;
}

const MAX_BAR_WIDTH = 12;

interface FooterState {
  readonly reachedEnd: boolean;
  readonly cursor: number;
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly windowed: boolean;
}

type FooterRow = readonly PreviewFooterSpan[];

/** The consequence with its `y/n` keys picked out, as in a one-screen confirmation. */
function consequenceSpans(consequence: string): readonly PreviewFooterSpan[] {
  const marker = consequence.indexOf("y/n");
  if (marker < 0) return [{ text: consequence, role: "consequence" }];
  return [
    { text: consequence.slice(0, marker), role: "consequence" },
    { text: "y", role: "yes" },
    { text: "/", role: "position" },
    { text: "n", role: "no" },
    ...(marker + 3 < consequence.length ? [{ text: consequence.slice(marker + 3), role: "position" as const }] : []),
  ];
}

/** The progress line and the action line, before wrapping. */
function footerSpans(state: FooterState, chrome: PreviewChrome, width: number): readonly [FooterRow, FooterRow] {
  const range = (total: number, start: number, end: number) => ` · ${start}–${end} of ${total}`;
  const position = (cursor: number, start: number, end: number) =>
    `Review ${cursor} of ${state.total}${state.windowed ? range(state.total, start, end) : ""}`;
  // Sized for the widest position text so the bar, and so the footer height, never changes while paging.
  const widest = position(state.total, state.total, state.total);
  const barWidth = Math.min(Math.max(width - stringWidth(`read  100% · ${widest}`), 0), MAX_BAR_WIDTH);
  const read = state.total === 0 ? 1 : state.end / state.total;
  const filled = Math.floor(read * barWidth);
  const bar = barWidth === 0 ? "" : `${"█".repeat(filled)}${"░".repeat(barWidth - filled)} `;
  const progress: PreviewFooterSpan[] = state.reachedEnd
    ? [{ text: "read ✓", role: "read" }]
    : [{ text: `read ${bar}${Math.floor(read * 100)}%`, role: "reading" }];
  if (state.total > 0) progress.push({ text: ` · ${position(state.cursor + 1, state.start + 1, state.end)}`, role: "position" });
  if (!state.reachedEnd) progress.push({ text: " · arrows/Pg page", role: "position" });
  else if (chrome.consequence !== undefined) progress.push({ text: " · ", role: "position" }, ...consequenceSpans(chrome.consequence));
  const actions: PreviewFooterSpan[] = chrome.action === undefined ? [] : [{ text: `[y] ${chrome.action}`, role: "action" }, { text: "  ", role: "cancel" }];
  actions.push({ text: chrome.cancel ?? "[n] cancel", role: "cancel" });
  return [progress, actions];
}

/** The spans covering `length` UTF-16 units of their joined text from `offset`. */
export function sliceSpans<T extends { readonly text: string }>(spans: readonly T[], offset: number, length: number): readonly T[] {
  const end = offset + length;
  let spanStart = 0;
  const visible: T[] = [];
  for (const span of spans) {
    const spanEnd = spanStart + span.text.length;
    const start = Math.max(offset, spanStart);
    const stop = Math.min(end, spanEnd);
    if (start < stop) visible.push({ ...span, text: span.text.slice(start - spanStart, stop - spanStart) });
    spanStart = spanEnd;
  }
  return visible;
}

function wrapSpans(spans: FooterRow, width: number): readonly FooterRow[] {
  return wrapLine(spans.map(({ text }) => text).join(""), width).map(({ row, offset }) => sliceSpans(spans, offset, row.length));
}

/** `rows` cut to `maxRows`, the last kept row ending in an ellipsis when something was cut. */
function clipRows(rows: readonly FooterRow[], maxRows: number): readonly FooterRow[] {
  if (rows.length <= maxRows) return rows;
  const last = [...rows[maxRows - 1]!];
  const tail = last.pop()!;
  const shortened = [...graphemes.segment(tail.text)].slice(0, -1).map(({ segment }) => segment).join("");
  return [...rows.slice(0, maxRows - 1), [...last, ...(shortened ? [{ ...tail, text: shortened }] : []), { ...tail, text: "…" }]];
}

/**
 * The footer lines wrapped to `width` within `maxRows`: the progress row, which carries the
 * consequence, keeps all but one row if it needs them, the action row the rest. A cut row ends in an
 * ellipsis instead of pushing the panel past the terminal.
 */
function layoutFooter([progressLine, actionLine]: readonly [FooterRow, FooterRow], width: number, maxRows: number): readonly FooterRow[] {
  const progress = wrapSpans(progressLine, width);
  const actions = wrapSpans(actionLine, width);
  const progressRows = Math.min(progress.length, Math.max(maxRows - 1, 1));
  return [...clipRows(progress, progressRows), ...clipRows(actions, Math.max(maxRows - progressRows, 1))];
}

/** Footer rows for the widest position and both reading states, so paging never changes the height. */
function reservedFooterRows(total: number, windowed: boolean, chrome: PreviewChrome, width: number, maxRows: number): number {
  const widest = { cursor: Math.max(total - 1, 0), start: Math.max(total - 1, 0), end: total, total, windowed };
  return Math.max(
    layoutFooter(footerSpans({ ...widest, reachedEnd: false }, chrome, width), width, maxRows).length,
    layoutFooter(footerSpans({ ...widest, reachedEnd: true }, chrome, width), width, maxRows).length,
  );
}

/** `title` cut, with an ellipsis, to the longest start that wraps to at most `maxRows` once escaped. */
function clipTitle(title: string, width: number, maxRows: number): string {
  const fits = (text: string) => wrapLine(escapeControlText(text), width).length <= maxRows;
  if (fits(title)) return title;
  const parts = [...graphemes.segment(title)].map(({ segment }) => segment);
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(`${parts.slice(0, middle).join("")}…`)) low = middle;
    else high = middle - 1;
  }
  return `${parts.slice(0, low).join("")}…`;
}

export function previewViewport(
  rawLines: readonly string[],
  cursor: number,
  terminalRows: number,
  terminalColumns: number,
  rawChrome: PreviewChrome,
): PreviewViewport {
  const lines = rawLines.map(escapeControlText);
  const chrome = escapeChrome(rawChrome);
  const contentWidth = Math.max(terminalColumns - 8, 1);
  const wrapped = lines.flatMap((line, sourceLine) => wrapLine(line, contentWidth, true).map((wrappedRow) => ({ ...wrappedRow, sourceLine })));
  const previewRows = wrapped.map(({ row }) => row);
  const total = previewRows.length;
  const headerRows = headerTabRowCount(contentWidth) + 3;
  const reservedRows = chrome.reservedRows !== undefined && chrome.reservedRows > 0 ? Math.ceil(chrome.reservedRows) : 0;
  // The footer, with its question and its action, is reserved first; the title takes what remains after a row of content.
  const footerRows = Math.max(reservedFooterRows(total, false, chrome, contentWidth, Infinity), reservedFooterRows(total, true, chrome, contentWidth, Infinity));
  const titleBudget = Math.max(terminalRows - headerRows - 1 - 2 - reservedRows - 1 - footerRows, 1);
  const titleRows = wrapLine(escapeControlText(clipTitle(rawChrome.title, contentWidth, titleBudget)), contentWidth).map(({ row }) => row);
  const fixedRows = headerRows + 1 + 2 + titleRows.length + reservedRows;
  // At least one preview row stays visible; the footer is cut to what remains.
  const maxFooterRows = Math.max(terminalRows - fixedRows - 1, 2);
  const rowsWithFooter = (windowed: boolean) =>
    Math.max(terminalRows - fixedRows - reservedFooterRows(total, windowed, chrome, contentWidth, maxFooterRows), 1);
  const windowed = total > rowsWithFooter(false);
  const height = rowsWithFooter(windowed);
  const selected = Math.min(Math.max(cursor, 0), Math.max(total - 1, 0));
  const start = Math.min(Math.max(selected - Math.floor(height / 2), 0), Math.max(total - height, 0));
  const end = Math.min(start + height, total);
  const reachedEnd = end === total;
  return {
    titleRows,
    rows: previewRows.slice(start, end),
    sourceLines: wrapped.slice(start, end).map(({ sourceLine }) => sourceLine),
    sourceOffsets: wrapped.slice(start, end).map(({ offset }) => offset),
    prefixLengths: wrapped.slice(start, end).map(({ prefixLength }) => prefixLength),
    start,
    end,
    total,
    cursor: selected,
    height,
    reachedEnd,
    footer: layoutFooter(footerSpans({ reachedEnd, cursor: selected, start, end, total, windowed }, chrome, contentWidth), contentWidth, maxFooterRows),
  };
}

export type PreviewGeometry = (lines: readonly string[], cursor: number, chrome: PreviewChrome) => PreviewViewport;

/** The viewport of a preview at the current terminal size; key handling and rendering share it. */
export function usePreviewGeometry(): PreviewGeometry {
  const { rows, columns } = useWindowSize();
  return (lines, cursor, chrome) => previewViewport(lines, cursor, rows || 24, columns || 80, chrome);
}
