// Loaded with `node --test --import` so every test process starts from a neutral environment.
// - HOME/USERPROFILE and the Windows state variables: pinned to a fresh directory, so a test that
//   does not inject its own home cannot read or write the developer's real Agent Depot state (App
//   recipes, approval receipts). Tests that read the real state directory are machine- and
//   order-dependent; tests that need recipes inject their own `recipesDirectory`.
// - XDG_STATE_HOME, XDG_CACHE_HOME and PI_CODING_AGENT_DIR: deleted, so shell overrides cannot
//   redirect tests to real user state or the real Git Source cache, or away from the isolated HOME.
//   XDG_DATA_HOME is not read by the product, so it needs no handling.
// - XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM: git children would otherwise read the
//   developer's `$XDG_CONFIG_HOME/git/config` and the system git config (url rewrites, signing, hook
//   paths), so results would depend on the machine. XDG_CONFIG_HOME is deleted, the system config is
//   disabled and the global one points into the isolated HOME. Fixtures that commit must set their own
//   user.name/user.email; tests that need their own git config override these after this preload runs.
// - AGENT_DEPOT_NO_ANIMATION: set to 1 so Working renders one static frame; a ticking spinner would
//   change every frame and break tests that wait for `frame !== before`.
// - FORCE_COLOR: `node --test` sets it for its child processes when run from a real terminal, which
//   makes Ink render ANSI colors into the frames the TUI tests match (so `npm publish` failed in a TTY).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_DEPOT_NO_ANIMATION = "1";
delete process.env.FORCE_COLOR;
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_CACHE_HOME;
delete process.env.XDG_CONFIG_HOME;
delete process.env.PI_CODING_AGENT_DIR;

const home = mkdtempSync(path.join(tmpdir(), "agent-depot-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
