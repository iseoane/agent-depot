import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { defaultGitSourceCachePath } from "../src/git-source.js";
import { defaultPackageStateDirectory } from "../src/package-state.js";
import { defaultSourceStatePath } from "../src/source-state.js";
import { isolateUserState } from "./state-home.js";

test("isolateUserState redirects every default state and cache path under the home despite shell overrides, then restores", () => {
  const home = path.resolve("fixture-home");
  const outside = path.resolve("outside-state");
  const keys = ["XDG_STATE_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = path.join(outside, key);
    const isolated = isolateUserState(home);
    const inside = (candidate: string) => path.relative(home, candidate).split(path.sep)[0] !== "..";
    assert.ok(inside(defaultSourceStatePath(process.env, process.platform, home)), "source state");
    assert.ok(inside(defaultPackageStateDirectory(process.env, process.platform, home)), "package state");
    assert.ok(inside(defaultGitSourceCachePath(process.env, process.platform, home)), "git cache");
    assert.ok(inside(isolated.stateDirectory), "reported state directory");
    isolated.restore();
    for (const key of keys) assert.equal(process.env[key], path.join(outside, key), `${key} restored`);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
