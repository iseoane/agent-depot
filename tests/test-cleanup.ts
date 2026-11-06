import type { TestContext } from "node:test";

export function deferCleanup(t: TestContext, cleanup: () => void | Promise<void>): void {
  t.after(cleanup);
}
