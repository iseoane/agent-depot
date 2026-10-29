import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split text on grapheme boundaries so wide and combining characters wrap at `width` columns. */
export function wrapText(value: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = stringWidth(segment);
    if (line && lineWidth + segmentWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += segment;
    lineWidth += segmentWidth;
  }
  return [...lines, line];
}

/** `lines` capped to `maxRows`, with the last visible row shortened to `width` plus an ellipsis. */
export function fitLines(lines: readonly string[], maxRows: number, width: number): readonly string[] {
  if (maxRows <= 0) return [];
  if (lines.length <= maxRows) return lines;
  const visible = lines.slice(0, maxRows);
  let last = "";
  let used = 0;
  for (const { segment } of graphemes.segment(visible[maxRows - 1]!)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > width - 1) break;
    last += segment;
    used += segmentWidth;
  }
  visible[maxRows - 1] = `${last}…`;
  return visible;
}

/**
 * `lines` capped to `maxRows` by dropping the middle: the first and last rows stay (the start and end of
 * a path) with a row counting what was left out. With two rows or fewer it falls back to `fitLines`.
 */
export function elideMiddle(lines: readonly string[], maxRows: number, width: number): readonly string[] {
  if (lines.length <= maxRows) return lines;
  if (maxRows <= 2) return fitLines(lines, maxRows, width);
  const tail = lines.slice(lines.length - (maxRows - 2));
  const hidden = lines.length - 1 - tail.length;
  return [lines[0]!, `… ${hidden} more ${hidden === 1 ? "row" : "rows"}`, ...tail];
}

/** One line shortened to `width` columns plus an ellipsis, for single-row labels. */
export function clipText(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  let last = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > Math.max(width - 1, 0)) break;
    last += segment;
    used += segmentWidth;
  }
  return `${last}…`;
}
