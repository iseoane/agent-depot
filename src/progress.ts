import stringWidth from "string-width";

import { animationEnabled, formatElapsed, SPINNER_FRAMES, SPINNER_TICK_MS, STATIC_GLYPH } from "./tui/working-model.js";

/** The slice of a stream progress needs; `process.stderr` satisfies it. Progress never writes to stdout. */
export interface ProgressStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(text: string): unknown;
}

/** Timer seam so tests can observe `unref` and cleanup without waiting on real clocks. */
export interface ProgressTimers {
  setInterval(callback: () => void, ms: number): { unref(): unknown };
  clearInterval(timer: { unref(): unknown }): void;
}

/**
 * Runs `work` so that child processes it starts report their output to `sink`; `withChildOutput` from
 * the process runner. Progress takes it as an option so it never depends on the runner itself, and
 * without it no child output is shown.
 */
export type ChildOutputTap = <T>(sink: (text: string, stream: "stdout" | "stderr") => void, work: () => Promise<T>) => Promise<T>;

export interface ProgressOptions {
  readonly stream?: ProgressStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly timers?: ProgressTimers;
  /** Stream every child output line to the stream as it arrives, after one plain step line, with no spinner. */
  readonly verbose?: boolean;
  readonly tapChildOutput?: ChildOutputTap;
}

/** Reports what a long CLI step is doing, on stderr only. */
export interface Progress {
  /**
   * Runs `work` while showing `label`: an animated spinner with elapsed time on an interactive
   * stderr, otherwise one plain line. The spinner line is erased before this settles, on success
   * and on error. A step started while another is running is not shown separately.
   * `mayPrompt` marks a step whose child process (for example `git` asking for credentials on the
   * terminal) can wait for the user: it gets one static line and is never redrawn over a prompt.
   * While the spinner is drawn, the last few lines the step's child processes print are shown under
   * it and erased with it.
   */
  run<T>(label: string, work: () => Promise<T>, options?: { readonly mayPrompt?: boolean }): Promise<T>;
  /** Erases a drawn spinner line so a line printed now is not garbled; the next tick redraws it. */
  clear(): void;
}

/** Progress that shows nothing, for embedders and tests that capture output themselves. */
export const NO_PROGRESS: Progress = { run: (_label, work) => work(), clear: () => undefined };

const ERASE_LINE = "\r\u001b[2K";

/** Cuts `text` to under `width` terminal columns so a redraw never wraps and cursor movement stays exact. */
function fit(text: string, width: number | undefined): string {
  if (width === undefined || width < 2 || stringWidth(text) < width) return text;
  let kept = "";
  let used = 0;
  for (const character of text) {
    const columns = stringWidth(character);
    if (used + columns > width - 2) break;
    kept += character;
    used += columns;
  }
  return `${kept}…`;
}

/** How many child output lines the spinner shows under its own line. */
const TAIL_LINES = 3;
/** A child line longer than this without a line break is shown as it is, so a runaway line cannot grow memory. */
const MAX_PENDING_LINE = 4096;
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * Child output is untrusted terminal input: an escape sequence would move the cursor and break the
 * redraw, and a `\r` progress bar (npm, git) should show only its latest state.
 */
function displayLine(raw: string): string {
  const afterReturn = raw.replace(/\r$/u, "").split("\r").at(-1) ?? "";
  return afterReturn.replace(TERMINAL_ESCAPES, "").replaceAll("\t", " ").replace(CONTROL_CHARACTERS, "").trimEnd();
}

/** Turns chunks of each output stream into complete display lines; `flush` emits what is left unterminated. */
function lineSplitter(onLine: (line: string) => void) {
  const pending = { stdout: "", stderr: "" };
  const emit = (raw: string): void => {
    const line = displayLine(raw);
    if (line !== "") onLine(line);
  };
  return {
    write(text: string, stream: "stdout" | "stderr"): void {
      const parts = (pending[stream] + text).split("\n");
      pending[stream] = parts.pop() ?? "";
      for (const part of parts) emit(part);
      if (pending[stream].length > MAX_PENDING_LINE) {
        emit(pending[stream]);
        pending[stream] = "";
      }
    },
    flush(): void {
      for (const stream of ["stdout", "stderr"] as const) {
        emit(pending[stream]);
        pending[stream] = "";
      }
    },
  };
}

/** Moves to the first row of a frame of `rows` rows and erases it, so a frame with a tail leaves nothing behind. */
function eraseFrame(rows: number): string {
  return rows <= 1 ? ERASE_LINE : `\u001b[${rows - 1}A\r\u001b[J`;
}

function withEllipsis(label: string): string {
  return label.endsWith("…") ? label : `${label}…`;
}

/** Creates the progress reporter for one CLI run. */
export function createProgress(options: ProgressOptions = {}): Progress {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const timers: ProgressTimers = options.timers ?? {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
  };
  const tap = options.tapChildOutput;
  const verbose = options.verbose === true;
  let active = false;
  let drawnRows = 0;

  function clear(): void {
    if (drawnRows === 0) return;
    const rows = drawnRows;
    drawnRows = 0;
    stream.write(eraseFrame(rows));
  }

  /** Runs `work` while its child output goes to `splitter`; the tap goes silent as soon as the step ends. */
  async function showChildOutput<T>(work: () => Promise<T>, splitter: ReturnType<typeof lineSplitter>): Promise<T> {
    if (tap === undefined) return work();
    let live = true;
    try {
      return await tap((text, source) => { if (live) splitter.write(text, source); }, work);
    } finally {
      live = false;
      splitter.flush();
    }
  }

  async function run<T>(label: string, work: () => Promise<T>, runOptions: { readonly mayPrompt?: boolean } = {}): Promise<T> {
    if (active) return work();
    const text = withEllipsis(label);
    if (verbose || stream.isTTY !== true || !animationEnabled(env) || runOptions.mayPrompt === true) {
      // Not animated: one persistent line, so logs and pipes stay readable and nothing needs erasing.
      stream.write(`${stream.isTTY === true ? `${STATIC_GLYPH} ` : ""}${text}\n`);
      active = true;
      try {
        // Verbose output is plain lines, so it is also safe next to a prompt; otherwise child output stays hidden.
        return verbose ? await showChildOutput(work, lineSplitter((line) => stream.write(`${line}\n`))) : await work();
      } finally { active = false; }
    }
    const startedAt = now();
    let tick = 0;
    const tail: string[] = [];
    // A terminal too short for the tail keeps the single-line spinner rather than scrolling.
    const room = stream.rows === undefined || stream.rows >= TAIL_LINES + 2;
    const splitter = lineSplitter((line) => {
      if (!room) return;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    });
    const draw = (): void => {
      const elapsed = formatElapsed(now() - startedAt);
      const line = `${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} ${text}${elapsed === "" ? "" : ` ${elapsed}`}`;
      tick += 1;
      const frame = [line, ...tail.map((child) => `  ${child}`)].map((row) => fit(row, stream.columns));
      const previousRows = drawnRows;
      drawnRows = frame.length;
      stream.write(`${eraseFrame(previousRows)}${frame.join("\n")}`);
    };
    active = true;
    draw();
    const timer = timers.setInterval(draw, SPINNER_TICK_MS);
    // A redraw timer alone must never keep the process alive.
    timer.unref();
    try {
      return await showChildOutput(work, splitter);
    } finally {
      timers.clearInterval(timer);
      active = false;
      clear();
    }
  }

  return { run, clear };
}
