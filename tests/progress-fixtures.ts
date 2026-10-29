import type { Progress, ProgressStream, ProgressTimers } from "../src/progress.js";

/** A stream that records what progress writes; `isTTY` decides whether progress animates. */
export function fakeStream(options: { isTTY?: boolean; columns?: number; rows?: number } = {}): ProgressStream & { readonly writes: string[] } {
  const writes: string[] = [];
  return { ...options, writes, write: (text: string) => writes.push(text) };
}

/** Interval timers that run only when the test fires them, and remember whether they were unref'd. */
export function fakeTimers() {
  const live = new Map<object, () => void>();
  const unreffed = new Set<object>();
  const intervals: number[] = [];
  const timers: ProgressTimers = {
    setInterval(callback, ms) {
      const timer = { unref: () => { unreffed.add(timer); return timer; } };
      intervals.push(ms);
      live.set(timer, callback);
      return timer;
    },
    clearInterval(timer) { live.delete(timer); },
  };
  return {
    timers,
    intervals,
    get active() { return live.size; },
    get everUnreffed() { return unreffed.size; },
    tick() { for (const callback of [...live.values()]) callback(); },
  };
}

/** Progress that records each step label (and which steps were marked `mayPrompt`) and otherwise stays out of the way. */
export function recordingProgress(): Progress & { readonly labels: string[]; readonly prompting: string[] } {
  const labels: string[] = [];
  const prompting: string[] = [];
  return {
    labels,
    prompting,
    run: (label, work, options) => {
      labels.push(label);
      if (options?.mayPrompt === true) prompting.push(label);
      return work();
    },
    clear: () => undefined,
  };
}

/**
 * Replays what progress wrote onto a blank terminal of `columns` width and returns the visible rows
 * (trailing blanks trimmed). Understands `\r`, `\n`, cursor-up and erase-in-line/display, which is all progress emits,
 * so a test can assert what a user sees instead of the escape bytes.
 */
export function screenOf(writes: readonly string[], columns = 80): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let column = 0;
  const text = writes.join("");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\u001b") {
      let end = index + 2;
      while (end < text.length && text[end]! >= "0" && text[end]! <= "9") end += 1;
      const amount = Number(text.slice(index + 2, end) || 0);
      const final = text[end];
      if (text[index + 1] !== "[" || final === undefined) throw new Error(`unsupported escape at ${index}`);
      if (final === "A") row = Math.max(0, row - (amount || 1));
      else if (final === "K") rows[row] = [];
      else if (final === "J") { rows[row] = rows[row]!.slice(0, column); rows.length = row + 1; }
      else throw new Error(`unsupported escape ${text.slice(index, end + 1)}`);
      index = end;
    } else if (character === "\r") column = 0;
    else if (character === "\n") { row += 1; column = 0; rows[row] ??= []; }
    else {
      if (column >= columns) { row += 1; column = 0; rows[row] ??= []; }
      rows[row]![column] = character;
      column += 1;
    }
  }
  return rows.map((cells) => Array.from({ length: cells.length }, (_, cell) => cells[cell] ?? " ").join("").trimEnd());
}
