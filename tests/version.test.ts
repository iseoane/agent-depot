import assert from "node:assert/strict";
import { test } from "node:test";

import { VERSION } from "../src/version.js";

test("public package smoke test exposes a semantic version", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
