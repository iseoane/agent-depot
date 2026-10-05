// Loaded with `node --test --import` so every test process starts from a neutral environment.
// - HOME/USERPROFILE and the Windows state variables: pinned to a fresh directory, so a test that
//   does not inject its own home cannot read or write the developer's real Agent Depot state (App
//   recipes, approval receipts). Tests that read the real state directory are machine- and
//   order-dependent; tests that need recipes inject their own `recipesDirectory`.
// - XDG_STATE_HOME: deleted, so a manual-testing sandbox exported in the shell cannot decide where
//   the App recipes directory resolves to.
// - FORCE_COLOR: `node --test` sets it for its child processes when run from a real terminal, which
//   makes Ink render ANSI colors into the frames the TUI tests match (so `npm publish` failed in a TTY).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

delete process.env.FORCE_COLOR;
delete process.env.XDG_STATE_HOME;

const home = mkdtempSync(path.join(tmpdir(), "agent-depot-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
