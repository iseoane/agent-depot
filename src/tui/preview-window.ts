import stringWidth from "string-width";

import { headerTabRowCount } from "./header-layout.js";

export interface PreviewChrome {
  readonly title: string;
  readonly questions: readonly string[];
  /** Rows rendered by the parent view above the panel. */
  readonly reservedRows?: number;
}

export interface PreviewViewport {
  readonly rows: readonly string[];
  /** Source line index for each physically wrapped row. */
  readonly sourceLines: readonly number[];
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly cursor: number;
  readonly height: number;
  readonly reachedEnd: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapLine(line: string, width: number): string[] {
  const segments = [...graphemes.segment(line)];
  if (segments.length === 0) return [""];
  const wrapped: string[] = [];
  let row = "";
  let rowWidth = 0;
  for (const { segment } of segments) {
    const segmentWidth = stringWidth(segment);
    if (row !== "" && rowWidth + segmentWidth > width) {
      wrapped.push(row);
      row = "";
      rowWidth = 0;
    }
    row += segment;
    rowWidth += segmentWidth;
  }
  wrapped.push(row);
  return wrapped;
}

export function previewViewport(
  lines: readonly string[],
  cursor: number,
  terminalRows: number,
  terminalColumns: number,
  chrome: PreviewChrome = { title: "Confirmation", questions: ["Scroll to end before y; n cancels.", "Confirm? y/n"] },
): PreviewViewport {
  const contentWidth = Math.max(terminalColumns - 4, 1);
  const wrapped = lines.flatMap((line, sourceLine) => wrapLine(line, contentWidth).map((row) => ({ row, sourceLine })));
  const previewRows = wrapped.map(({ row }) => row);
  const headerRows = headerTabRowCount(contentWidth) + 3;
  const titleRows = wrapLine(chrome.title, contentWidth).length;
  const questionRows = Math.max(...chrome.questions.map(question => wrapLine(question, contentWidth).length));
  const panelChromeRows = 2 + titleRows + questionRows + 1;
  const reservedRows = chrome.reservedRows !== undefined && chrome.reservedRows > 0 ? Math.ceil(chrome.reservedRows) : 0;
  const availableRows = Math.max(terminalRows - headerRows - 1 - panelChromeRows - reservedRows, 1);
  const height = previewRows.length > availableRows ? Math.max(availableRows - 1, 1) : availableRows;
  const selected = Math.min(Math.max(cursor, 0), Math.max(previewRows.length - 1, 0));
  const start = Math.min(Math.max(selected - Math.floor(height / 2), 0), Math.max(previewRows.length - height, 0));
  const end = Math.min(start + height, previewRows.length);
  return {
    rows: previewRows.slice(start, end),
    sourceLines: wrapped.slice(start, end).map(({ sourceLine }) => sourceLine),
    start,
    end,
    total: previewRows.length,
    cursor: selected,
    height,
    reachedEnd: end === previewRows.length,
  };
}
