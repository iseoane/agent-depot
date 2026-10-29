import type { TestContext } from "node:test";

/**
 * Turns the progress animation on for one test (the shared test environment turns it off), because
 * elapsed time only shows while animating, and returns a clock the test moves by hand.
 * `Date.now` keeps running, so waiting for a frame still works; `advance` adds to it.
 * Both are undone when the test ends.
 */
export function animatedClock(t: TestContext): { advance(ms: number): void } {
  const previous = process.env.AGENT_DEPOT_NO_ANIMATION;
  process.env.AGENT_DEPOT_NO_ANIMATION = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_DEPOT_NO_ANIMATION;
    else process.env.AGENT_DEPOT_NO_ANIMATION = previous;
  });
  const real = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  return { advance: (ms) => { offset += ms; } };
}
