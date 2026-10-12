import stringWidth from "string-width";

import { headerTabRowCount } from "./header-layout.js";

export interface PreviewViewport {
  readonly rows: readonly string[];
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
): PreviewViewport {
  const contentWidth = Math.max(terminalColumns - 4, 1);
  const previewRows = lines.flatMap(line => wrapLine(line, contentWidth));
  const headerRows = headerTabRowCount(Math.max(terminalColumns - 4, 1)) + 3;
  const panelChromeRows = 6;
  const height = Math.max(terminalRows - headerRows - 1 - panelChromeRows, 1);
  const selected = Math.min(Math.max(cursor, 0), Math.max(previewRows.length - 1, 0));
  const start = Math.min(Math.max(selected - Math.floor(height / 2), 0), Math.max(previewRows.length - height, 0));
  const end = Math.min(start + height, previewRows.length);
  return {
    rows: previewRows.slice(start, end),
    start,
    end,
    total: previewRows.length,
    cursor: selected,
    height,
    reachedEnd: end === previewRows.length,
  };
}
