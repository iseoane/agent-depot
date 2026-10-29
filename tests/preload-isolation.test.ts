import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const PRELOAD = path.resolve("dist", "tests", "isolated-env.js");
const GIT_SOURCE = pathToFileURL(path.resolve("dist", "src", "git-source.js")).href;
const SOURCE_STATE = pathToFileURL(path.resolve("dist", "src", "source-state.js")).href;

// Every XDG root the product reads is set to a sentinel outside the sandbox, as a developer shell
// that exports them would; the preload must keep the default paths away from it.
test("the isolation preload keeps default state and cache paths out of inherited XDG roots", () => {
  const sentinel = mkdtempSync(path.join(tmpdir(), "agent-depot-xdg-sentinel-"));
  try {
    const script = `
      import { defaultGitSourceCachePath } from ${JSON.stringify(GIT_SOURCE)};
      import { defaultSourceStatePath } from ${JSON.stringify(SOURCE_STATE)};
      console.log(JSON.stringify([defaultGitSourceCachePath(), defaultSourceStatePath()]));
    `;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_STATE_HOME: path.join(sentinel, "state"),
      XDG_CACHE_HOME: path.join(sentinel, "cache"),
      XDG_CONFIG_HOME: path.join(sentinel, "config"),
      XDG_DATA_HOME: path.join(sentinel, "data"),
    };
    const result = spawnSync(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", script], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const defaults = JSON.parse(result.stdout) as string[];
    for (const resolved of defaults) {
      assert.ok(!resolved.startsWith(sentinel), `${resolved} resolves under the inherited XDG sentinel ${sentinel}`);
    }
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
  }
});
