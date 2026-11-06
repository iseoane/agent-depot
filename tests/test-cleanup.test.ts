import assert from "node:assert/strict";
import { test } from "node:test";

import { deferCleanup } from "./test-cleanup.js";

test("deferred cleanups run last-registered first, so a view registered after its directories is torn down before them", async t => {
  const order: string[] = [];
  await t.test("fixture", async fixture => {
    deferCleanup(fixture, () => { order.push("remove directories"); });
    deferCleanup(fixture, async () => { order.push("settle view"); });
    deferCleanup(fixture, () => { order.push("unmount view"); });
  });
  assert.deepEqual(order, ["unmount view", "settle view", "remove directories"]);
});

test("a cleanup registered while an earlier one is pending still runs after the later ones", async t => {
  const order: string[] = [];
  await t.test("fixture", async fixture => {
    deferCleanup(fixture, async () => {
      await new Promise(resolve => setImmediate(resolve));
      order.push("remove directories");
    });
    deferCleanup(fixture, async () => {
      await new Promise(resolve => setImmediate(resolve));
      order.push("unmount view");
    });
  });
  assert.deepEqual(order, ["unmount view", "remove directories"]);
});
