import assert from "node:assert/strict";
import { test } from "node:test";

import type { InstallationsData } from "../src/tui/installations.js";
import { createViewRetention, invalidateRetention } from "../src/tui/view-retention.js";

const data = { sources: [] } as unknown as InstallationsData;

test("invalidating drops what was kept and moves the generation past loads that began earlier", () => {
  const retention = createViewRetention();
  const began = retention.generation;
  retention.installations = data;
  retention.catalogKey = "all";
  invalidateRetention(retention);
  assert.equal(retention.installations, undefined);
  assert.equal(retention.catalogKey, undefined);
  assert.equal(retention.catalogSkills, undefined);
  assert.equal(retention.catalogApps, undefined);
  assert.equal(retention.installed, undefined);
  assert.notEqual(retention.generation, began, "a load that began before the invalidation must see a different generation");
});

test("invalidating without a retention is a no-op", () => {
  assert.doesNotThrow(() => invalidateRetention(undefined));
});
