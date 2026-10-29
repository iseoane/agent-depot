import { animationEnabled, formatElapsed, SPINNER_FRAMES, SPINNER_TICK_MS, STATIC_GLYPH } from "./tui/working-model.js";

/** The slice of a stream progress needs; `process.stderr` satisfies it. Progress never writes to stdout. */
export interface ProgressStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(text: string): unknown;
}

/** Timer seam so tests can observe `unref` and cleanup without waiting on real clocks. */
export interface ProgressTimers {
  setInterval(callback: () => void, ms: number): { unref(): unknown };
  clearInterval(timer: { unref(): unknown }): void;
}

export interface ProgressOptions {
  readonly stream?: ProgressStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly timers?: ProgressTimers;
}

/** Reports what a long CLI step is doing, on stderr only. */
export interface Progress {
  /**
   * Runs `work` while showing `label`: an animated spinner with elapsed time on an interactive
   * stderr, otherwise one plain line. The spinner line is erased before this settles, on success
   * and on error. A step started while another is running is not shown separately.
   * `mayPrompt` marks a step whose child process (for example `git` asking for credentials on the
   * terminal) can wait for the user: it gets one static line and is never redrawn over a prompt.
   */
  run<T>(label: string, work: () => Promise<T>, options?: { readonly mayPrompt?: boolean }): Promise<T>;
  /** Erases a drawn spinner line so a line printed now is not garbled; the next tick redraws it. */
  clear(): void;
}

/** Progress that shows nothing, for embedders and tests that capture output themselves. */
export const NO_PROGRESS: Progress = { run: (_label, work) => work(), clear: () => undefined };

const ERASE_LINE = "\r\u001b[2K";

/** Cuts `text` to `width` columns (by code point) so a redraw never wraps and `\r` stays enough to erase it. */
function fit(text: string, width: number | undefined): string {
  if (width === undefined || width < 2) return text;
  const characters = Array.from(text);
  return characters.length < width ? text : `${characters.slice(0, width - 2).join("")}…`;
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
  let active = false;
  let drawn = false;

  function clear(): void {
    if (!drawn) return;
    drawn = false;
    stream.write(ERASE_LINE);
  }

  async function run<T>(label: string, work: () => Promise<T>, runOptions: { readonly mayPrompt?: boolean } = {}): Promise<T> {
    if (active) return work();
    const text = withEllipsis(label);
    if (stream.isTTY !== true || !animationEnabled(env) || runOptions.mayPrompt === true) {
      // Not animated: one persistent line, so logs and pipes stay readable and nothing needs erasing.
      stream.write(`${stream.isTTY === true ? `${STATIC_GLYPH} ` : ""}${text}\n`);
      active = true;
      try { return await work(); } finally { active = false; }
    }
    const startedAt = now();
    let tick = 0;
    const draw = (): void => {
      const elapsed = formatElapsed(now() - startedAt);
      const line = `${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} ${text}${elapsed === "" ? "" : ` ${elapsed}`}`;
      tick += 1;
      drawn = true;
      stream.write(`${ERASE_LINE}${fit(line, stream.columns)}`);
    };
    active = true;
    draw();
    const timer = timers.setInterval(draw, SPINNER_TICK_MS);
    // A redraw timer alone must never keep the process alive.
    timer.unref();
    try {
      return await work();
    } finally {
      timers.clearInterval(timer);
      active = false;
      clear();
    }
  }

  return { run, clear };
}
