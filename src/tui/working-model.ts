/** Braille spinner frames; one is shown per tick while an operation runs. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Fixed glyph shown instead of the spinner when animation is off. */
export const STATIC_GLYPH = "·";

/** How often the spinner advances and the elapsed time is redrawn. */
export const SPINNER_TICK_MS = 80;

/** Elapsed time stays hidden until the operation has run this long. */
const ELAPSED_THRESHOLD_MS = 1000;

/** `12s` or `1m 05s`; empty under one second. */
export function formatElapsed(ms: number): string {
  if (!(ms >= ELAPSED_THRESHOLD_MS)) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Animation is on unless `AGENT_DEPOT_NO_ANIMATION=1`, which tests set so frames stay static. */
export function animationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_DEPOT_NO_ANIMATION !== "1";
}

/** Whether a rendered frame starts with a Working line, so tests can wait for the real content. */
export function isWorkingFrame(text: string): boolean {
  return /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·] \S[^\n]*…/u.test(text.trimStart());
}

/** A mode held while an operation runs: what it is doing, and when the operation (not this step) began. */
export interface Busy {
  readonly kind: "busy";
  readonly label: string;
  readonly startedAt: number;
}

/** When an operation began: the start time of the busy mode it continues, otherwise now. Only busy modes carry one. */
export function operationStart(previous?: { readonly kind: string; readonly startedAt?: number }, now: () => number = Date.now): number {
  return previous?.startedAt ?? now();
}

/** The busy mode for `label`; it keeps the start time of an operation already busy, so the clock survives label changes. */
export function busy(label: string, previous?: { readonly kind: string; readonly startedAt?: number }, now: () => number = Date.now): Busy {
  return { kind: "busy", label, startedAt: operationStart(previous, now) };
}
