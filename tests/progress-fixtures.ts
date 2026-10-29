import type { Progress, ProgressStream, ProgressTimers } from "../src/progress.js";

/** A stream that records what progress writes; `isTTY` decides whether progress animates. */
export function fakeStream(options: { isTTY?: boolean; columns?: number } = {}): ProgressStream & { readonly writes: string[] } {
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
