import type { TestContext } from "node:test";

type Cleanup = () => void | Promise<void>;

const stacks = new WeakMap<TestContext, Cleanup[]>();

/**
 * Registers a cleanup that runs after every cleanup registered later for the same test.
 *
 * node:test runs `t.after` hooks in registration order. A fixture that removes its temporary
 * directories at creation time would therefore delete them before the test's later-rendered view is
 * settled and unmounted, and the view's in-flight state writes race the removal (ENOTEMPTY).
 * Register directory removal and view teardown both through this function; teardown of what was
 * created last then runs first. Mixing `t.after` into such a test reintroduces the original order.
 */
export function deferCleanup(t: TestContext, cleanup: Cleanup): void {
  const existing = stacks.get(t);
  if (existing) {
    existing.push(cleanup);
    return;
  }
  const stack = [cleanup];
  stacks.set(t, stack);
  t.after(async () => {
    const failures: unknown[] = [];
    for (const run of stack.reverse()) {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Several test cleanups failed");
  });
}
