import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Control, format and line-separator characters the TUI prints as escapes; the zero-width joiner stays for emoji sequences.
export const UNSAFE_PATTERN = "(?!\\u200D)[\\p{Cc}\\p{Cf}\\u2028\\u2029]";
const UNSAFE_CHARACTER = new RegExp(UNSAFE_PATTERN, "u");
/** Text shaped like an escape the TUI prints (`x1b`, `u202e`, `u{1f600}`), ignoring case. */
export const ESCAPE_TEXT = "x[0-9a-f]{2}|u[0-9a-f]{4}|u\\{[0-9a-f]{1,6}\\}";
const ESCAPE_UNIT = new RegExp(`(\\\\+)(${ESCAPE_TEXT})`, "giu");

/** Whether `escape` (`x1b`, `u202e`, `u{1f600}`) names a character the TUI would print as an escape. */
export function namesEscapedCharacter(escape: string): boolean {
  const code = Number.parseInt(escape.replace(/^[xu]\{?|\}$/giu, ""), 16);
  return code <= 0x10ffff && UNSAFE_CHARACTER.test(String.fromCodePoint(code));
}

interface TextUnit {
  readonly segment: string;
  readonly index: number;
}

/**
 * The units text is cut at: graphemes, except around an escape written as text that names a character the TUI escapes. Cut inside,
 * its doubled backslash would leave a `\x1b` that reads as a real ESC. The backslash run splits into pairs from the left, so a cut
 * between pairs keeps its parity, and the last one or two backslashes stay with the escape text: a unit is at most 12 columns. A unit
 * wider than `maxWidth` falls back to graphemes. `index` is the UTF-16 offset of the unit.
 */
export function textUnits(value: string, maxWidth = Infinity): readonly TextUnit[] {
  const units: TextUnit[] = [];
  let from = 0;
  const addGraphemes = (text: string, offset: number) => {
    for (const { segment, index } of graphemes.segment(text)) units.push({ segment, index: offset + index });
  };
  for (const match of value.matchAll(ESCAPE_UNIT)) {
    const [whole, backslashes = "", escape = ""] = match;
    if (!namesEscapedCharacter(escape)) continue;
    const tail = backslashes.length % 2 === 1 ? 1 : 2;
    const pairs = backslashes.length - tail;
    const unit = backslashes.slice(pairs) + escape;
    addGraphemes(value.slice(from, match.index), from);
    if (stringWidth(unit) > maxWidth) addGraphemes(whole, match.index);
    else {
      for (let offset = 0; offset < pairs; offset += 2) units.push({ segment: "\\\\", index: match.index + offset });
      units.push({ segment: unit, index: match.index + pairs });
    }
    from = match.index + whole.length;
  }
  addGraphemes(value.slice(from), from);
  return units;
}

/** Split text on grapheme boundaries so wide and combining characters wrap at `width` columns. */
export function wrapText(value: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment } of textUnits(value, width)) {
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
