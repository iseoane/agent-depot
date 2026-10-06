import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const FOCUSED_MODULE = path.resolve("dist", "tests", "package-owned-skills.test.js");

/**
 * Points every user-state root the default Source and Package resolvers read at
 * one throwaway directory, so a write that escapes the fixture home lands where
 * this test can see it.
 */
function sentinelEnvironment(sentinel: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(sentinel, "home"),
    USERPROFILE: path.join(sentinel, "home"),
    APPDATA: path.join(sentinel, "appdata"),
    LOCALAPPDATA: path.join(sentinel, "localappdata"),
    XDG_STATE_HOME: path.join(sentinel, "state"),
    XDG_CACHE_HOME: path.join(sentinel, "cache"),
    XDG_CONFIG_HOME: path.join(sentinel, "config"),
  };
  // A nested `node --test` must not attach to the outer runner's reporter.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

test("the focused module writes no user state when the isolation preload is omitted", () => {
  const sentinel = mkdtempSync(path.join(tmpdir(), "agent-depot-state-sentinel-"));
  try {
    const result = spawnSync(process.execPath, ["--test", FOCUSED_MODULE], {
      cwd: path.resolve("."),
      env: sentinelEnvironment(sentinel),
      encoding: "utf8",
    });
    const written = readdirSync(sentinel, { recursive: true }).map(entry => String(entry)).sort();
    assert.deepEqual(written, [], `the focused module wrote under the user-state sentinel: ${written.join(", ")}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /the CLI uninstall refuses a bundle-owned unmanaged path through the registered Source/);
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
  }
});
