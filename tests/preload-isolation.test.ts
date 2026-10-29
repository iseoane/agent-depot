import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// `--import` takes a file URL on Windows; a drive-letter path is rejected as an unsupported scheme.
const PRELOAD = pathToFileURL(path.resolve("dist", "tests", "isolated-env.js")).href;
const GIT_SOURCE = pathToFileURL(path.resolve("dist", "src", "git-source.js")).href;
const SOURCE_STATE = pathToFileURL(path.resolve("dist", "src", "source-state.js")).href;

function runUnderPreload(script: string, environment: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", script], {
    env: environment,
    cwd,
    encoding: "utf8",
  });
}

// Every state, cache and home root is set to a sentinel outside the sandbox, as a developer shell that
// exports them would; the preload must re-pin each one. HOME, USERPROFILE, APPDATA and LOCALAPPDATA are
// set too because the outer test runner has already pinned them, so leaving them out would make the
// assertion pass whether or not the inner preload works.
test("the isolation preload keeps the home, state and cache roots out of inherited sentinels", () => {
  const sentinel = mkdtempSync(path.join(tmpdir(), "agent-depot-xdg-sentinel-"));
  try {
    const script = `
      import os from "node:os";
      import { defaultGitSourceCachePath } from ${JSON.stringify(GIT_SOURCE)};
      import { defaultSourceStatePath } from ${JSON.stringify(SOURCE_STATE)};
      const { HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM } = process.env;
      console.log(JSON.stringify({
        paths: [defaultGitSourceCachePath(), defaultSourceStatePath(), os.homedir()],
        pinned: { HOME, USERPROFILE, APPDATA, LOCALAPPDATA, GIT_CONFIG_GLOBAL },
        XDG_CONFIG_HOME: XDG_CONFIG_HOME ?? null,
        GIT_CONFIG_NOSYSTEM: GIT_CONFIG_NOSYSTEM ?? null,
      }));
    `;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(sentinel, "home"),
      USERPROFILE: path.join(sentinel, "userprofile"),
      APPDATA: path.join(sentinel, "appdata"),
      LOCALAPPDATA: path.join(sentinel, "localappdata"),
      XDG_STATE_HOME: path.join(sentinel, "state"),
      XDG_CACHE_HOME: path.join(sentinel, "cache"),
      XDG_CONFIG_HOME: path.join(sentinel, "config"),
      XDG_DATA_HOME: path.join(sentinel, "data"),
      GIT_CONFIG_GLOBAL: path.join(sentinel, "gitconfig"),
    };
    const result = runUnderPreload(script, environment);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as {
      paths: string[];
      pinned: Record<string, string | undefined>;
      XDG_CONFIG_HOME: string | null;
      GIT_CONFIG_NOSYSTEM: string | null;
    };
    for (const resolved of observed.paths) {
      assert.ok(!resolved.startsWith(sentinel), `${resolved} resolves under the inherited sentinel ${sentinel}`);
    }
    for (const [name, value] of Object.entries(observed.pinned)) {
      assert.ok(value !== undefined && !value.startsWith(sentinel), `${name}=${value} was left under the inherited sentinel ${sentinel}`);
    }
    assert.equal(observed.XDG_CONFIG_HOME, null, "XDG_CONFIG_HOME must be removed so git children skip $XDG_CONFIG_HOME/git/config");
    assert.equal(observed.GIT_CONFIG_NOSYSTEM, "1");
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
  }
});

// A git child must not read the developer's user or system configuration. Each case plants a marker key
// where a developer machine could plausibly define one and git must report none of them. They are
// separate cases because git skips $XDG_CONFIG_HOME/git/config as soon as GIT_CONFIG_GLOBAL is set, so a
// combined environment would hide the XDG source.
const gitConfigCases: { name: string; files: Record<string, string>; environment: (sentinel: string) => NodeJS.ProcessEnv }[] = [
  {
    name: "XDG_CONFIG_HOME/git/config",
    files: { "config/git/config": "[agentdepot]\n\txdg = leaked\n" },
    environment: sentinel => ({ XDG_CONFIG_HOME: path.join(sentinel, "config"), GIT_CONFIG_GLOBAL: undefined }),
  },
  {
    name: "GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM files",
    files: { gitconfig: "[agentdepot]\n\tglobal = leaked\n", gitsystem: "[agentdepot]\n\tsystem = leaked\n" },
    environment: sentinel => ({
      GIT_CONFIG_GLOBAL: path.join(sentinel, "gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(sentinel, "gitsystem"),
    }),
  },
];

for (const gitCase of gitConfigCases) {
  test(`a git child under the isolation preload does not read ${gitCase.name}`, () => {
    const sentinel = mkdtempSync(path.join(tmpdir(), "agent-depot-git-sentinel-"));
    try {
      for (const [file, content] of Object.entries(gitCase.files)) {
        mkdirSync(path.dirname(path.join(sentinel, file)), { recursive: true });
        writeFileSync(path.join(sentinel, file), content);
      }
      const script = `
        import { spawnSync } from "node:child_process";
        const result = spawnSync("git", ["config", "--show-origin", "--get-regexp", "^agentdepot[.]"], { encoding: "utf8" });
        console.log(JSON.stringify({ error: result.error?.message ?? null, status: result.status, stdout: result.stdout, stderr: result.stderr }));
      `;
      const environment: NodeJS.ProcessEnv = { ...process.env, ...gitCase.environment(sentinel) };
      delete environment.GIT_CONFIG_NOSYSTEM;
      if (environment.GIT_CONFIG_GLOBAL === undefined) delete environment.GIT_CONFIG_GLOBAL;
      // Run from the sentinel so no repository-local configuration is in play.
      const result = runUnderPreload(script, environment, sentinel);
      assert.equal(result.status, 0, result.stderr);
      const git = JSON.parse(result.stdout) as { error: string | null; status: number | null; stdout: string; stderr: string };
      // `git config --get-regexp` exits 1 when nothing matches; any other outcome (git missing, usage
      // error) must not read as a pass.
      assert.equal(git.error, null);
      assert.equal(git.status, 1, `git reported inherited configuration or failed: ${git.stdout}${git.stderr}`);
      assert.equal(git.stdout, "");
    } finally {
      rmSync(sentinel, { recursive: true, force: true });
    }
  });
}
