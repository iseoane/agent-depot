import assert from "node:assert/strict";

/**
 * Polls an Ink test frame until the predicate holds. Ink renders asynchronously
 * (throttled), so a fixed delay after an update is racy under CPU load.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: RegExp | ((frame: string) => boolean),
  timeoutMs = 5000,
): Promise<string> {
  const matches = typeof predicate === "function" ? predicate : (frame: string) => predicate.test(frame);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = lastFrame() ?? "";
    if (matches(frame)) return frame;
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for frame; last frame:\n${frame}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
