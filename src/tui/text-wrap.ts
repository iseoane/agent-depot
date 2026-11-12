import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text shaped like an escape the TUI prints (`\x1b`, `\u202e`, `\u{1f600}`), ignoring case. */
export const ESCAPE_TEXT = "x[0-9a-f]{2}|u[0-9a-f]{4}|u\\{[0-9a-f]{1,6}\\}";
// A backslash run with the escape text it precedes; cut inside, a doubled backslash would leave `\x1b` that reads as a real escape.
const ESCAPE_UNIT = new RegExp(`\\\\+(?:${ESCAPE_TEXT})`, "giu");

/**
 * The units text is cut at: graphemes, except that an escape written as text, with the backslashes in front of it, stays whole.
 * `index` is the UTF-16 offset of the unit.
 */
export function textUnits(value: string): readonly { readonly segment: string; readonly index: number }[] {
  const units: { segment: string; index: number }[] = [];
  let from = 0;
  const addGraphemes = (end: number) => {
    for (const { segment, index } of graphemes.segment(value.slice(from, end))) units.push({ segment, index: from + index });
  };
  for (const match of value.matchAll(ESCAPE_UNIT)) {
    addGraphemes(match.index);
    units.push({ segment: match[0], index: match.index });
    from = match.index + match[0].length;
  }
  addGraphemes(value.length);
  return units;
}

/** Split text on grapheme boundaries so wide and combining characters wrap at `width` columns. */
export function wrapText(value: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment } of textUnits(value)) {
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
  for (const { segment } of textUnits(visible[maxRows - 1]!)) {
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
  for (const { segment } of textUnits(value)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > Math.max(width - 1, 0)) break;
    last += segment;
    used += segmentWidth;
  }
  return `${last}…`;
}
