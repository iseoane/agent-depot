import stringWidth from "string-width";

import { headerTabRowCount } from "./header-layout.js";

export interface PreviewChrome {
  readonly title: string;
  readonly questions: readonly string[];
  /** Rows rendered by the parent view above the panel. */
  readonly reservedRows?: number;
  /** Additional rows rendered inside the panel besides its confirmation question. */
  readonly footerRows?: number;
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
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

export function previewViewport(
  lines: readonly string[],
  cursor: number,
  terminalRows: number,
  terminalColumns: number,
  chrome: PreviewChrome = { title: "Confirmation", questions: ["Scroll to end before y; n cancels.", "Confirm? y/n"] },
): PreviewViewport {
  const contentWidth = Math.max(terminalColumns - 8, 1);
  const wrapped = lines.flatMap((line, sourceLine) => wrapLine(line, contentWidth).map(({ row, offset }) => ({ row, sourceLine, offset })));
  const previewRows = wrapped.map(({ row }) => row);
  const headerRows = headerTabRowCount(contentWidth) + 3;
  const titleRows = wrapLine(chrome.title, contentWidth).length;
  const questionRows = Math.max(...chrome.questions.map(question => wrapLine(question, contentWidth).length));
  const panelChromeRows = 2 + titleRows + questionRows + (chrome.footerRows ?? 1);
  const reservedRows = chrome.reservedRows !== undefined && chrome.reservedRows > 0 ? Math.ceil(chrome.reservedRows) : 0;
  const availableRows = Math.max(terminalRows - headerRows - 1 - panelChromeRows - reservedRows, 1);
  const height = previewRows.length > availableRows ? Math.max(availableRows - 1, 1) : availableRows;
  const selected = Math.min(Math.max(cursor, 0), Math.max(previewRows.length - 1, 0));
  const start = Math.min(Math.max(selected - Math.floor(height / 2), 0), Math.max(previewRows.length - height, 0));
  const end = Math.min(start + height, previewRows.length);
  return {
    rows: previewRows.slice(start, end),
    sourceLines: wrapped.slice(start, end).map(({ sourceLine }) => sourceLine),
    sourceOffsets: wrapped.slice(start, end).map(({ offset }) => offset),
    start,
    end,
    total: previewRows.length,
    cursor: selected,
    height,
    reachedEnd: end === previewRows.length,
  };
}
