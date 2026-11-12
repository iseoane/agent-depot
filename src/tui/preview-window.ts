import { useWindowSize } from "ink";
import stringWidth from "string-width";

import { headerTabRowCount } from "./header-layout.js";

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
  readonly rows: readonly string[];
  /** Source line index for each physically wrapped row. */
  readonly sourceLines: readonly number[];
  /** UTF-16 offset of each physical row within its logical source line. */
  readonly sourceOffsets: readonly number[];
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
const UNSAFE_PATTERN = "(?!\\u200D)[\\p{Cc}\\p{Cf}\\u2028\\u2029]";
const UNSAFE_CHARACTER = new RegExp(UNSAFE_PATTERN, "u");
// A backslash run before text shaped like an escape we print (`\x1b`, `\u202e`, `\u{1f600}`), or before a character we escape.
const ESCAPE_TEXT = "x[0-9a-f]{2}|u[0-9a-f]{4}|u\\{[0-9a-f]{1,6}\\}";
const ESCAPABLE = new RegExp(`(\\\\+)(?:(${ESCAPE_TEXT})|(?=${UNSAFE_PATTERN}))|${UNSAFE_PATTERN}`, "giu");

/** Whether `escape` (`x1b`, `u202e`, `u{1f600}`) names a character this module would print as an escape. */
function namesEscapedCharacter(escape: string): boolean {
  const code = Number.parseInt(escape.replace(/^[xu]\{?|\}$/gu, ""), 16);
  return code <= 0x10ffff && UNSAFE_CHARACTER.test(String.fromCodePoint(code));
}

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

function wrapLine(line: string, width: number): { readonly row: string; readonly offset: number }[] {
  const segments = [...graphemes.segment(line)];
  if (segments.length === 0) return [{ row: "", offset: 0 }];
  const wrapped: { row: string; offset: number }[] = [];
  let row = "";
  let rowWidth = 0;
  let rowOffset = 0;
  for (const { segment, index } of segments) {
    const segmentWidth = stringWidth(segment);
    if (row !== "" && rowWidth + segmentWidth > width) {
      wrapped.push({ row, offset: rowOffset });
      row = "";
      rowWidth = 0;
      rowOffset = index;
    }
    row += segment;
    rowWidth += segmentWidth;
  }
  wrapped.push({ row, offset: rowOffset });
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
  const wrapped = lines.flatMap((line, sourceLine) => wrapLine(line, contentWidth).map(({ row, offset }) => ({ row, sourceLine, offset })));
  const previewRows = wrapped.map(({ row }) => row);
  const total = previewRows.length;
  const headerRows = headerTabRowCount(contentWidth) + 3;
  const titleRows = wrapLine(chrome.title, contentWidth).length;
  const reservedRows = chrome.reservedRows !== undefined && chrome.reservedRows > 0 ? Math.ceil(chrome.reservedRows) : 0;
  const fixedRows = headerRows + 1 + 2 + titleRows + reservedRows;
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
    rows: previewRows.slice(start, end),
    sourceLines: wrapped.slice(start, end).map(({ sourceLine }) => sourceLine),
    sourceOffsets: wrapped.slice(start, end).map(({ offset }) => offset),
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
