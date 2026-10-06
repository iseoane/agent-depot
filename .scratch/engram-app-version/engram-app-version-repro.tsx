/**
 * Engram App version-surface repro. Investigation artifact for
 * `.scratch/engram-app-version/diagnosis.md`; not part of the suite, because
 * `pnpm test` globs `dist/tests/*.test.js` and this file is named `-repro.tsx`.
 *
 * Run it explicitly:
 *   pnpm build && node --test --import ./dist/tests/isolated-env.js dist/tests/engram-app-version-repro.js
 *
 * The fixture models the real channel: `tap` is what Homebrew's local formula
 * metadata reports (the recipe's `latest.argv` = `brew info`), `live` is what the
 * installed `engram` binary reports, and `upstream` is the release the tap's
 * origin/main formula names. Only `brew upgrade` moves `live` and refreshes `tap`
 * to `upstream`, which is how Homebrew behaves (auto-update runs for upgrade, not info).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import { compareAppVersions, sameAppVersion } from "../src/app-version.js";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { UpdatesView } from "../src/tui/updates-view.js";
import { renderExpanded } from "./render-expanded.js";
import { waitForFrame } from "./wait-for-frame.js";

const RECORDED_VERSION = "3.0.0";
const LIVE_AFTER_MANUAL_UPDATE = "3.1.0";
const UPSTREAM_RELEASE = "3.1.0";
const VERSION_PATTERN = "^engram\\s+v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)\\s*$";
const LATEST_PATTERN = "\"stable\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)\"";
const RECIPE = {
  name: "engram",
  platform: "linux",
  install: { argv: ["brew", "install", "--formula", "--yes", "gentleman-programming/tap/engram"] },
  update: { argv: ["brew", "upgrade", "--formula", "--yes", "gentleman-programming/tap/engram"] },
  uninstall: { argv: ["brew", "uninstall", "--formula", "gentleman-programming/tap/engram"] },
  version: { argv: ["engram", "version"], pattern: VERSION_PATTERN },
  latest: {
    argv: ["brew", "info", "--formula", "--json=v2", "gentleman-programming/tap/engram"],
    pattern: LATEST_PATTERN,
  },
};

interface EngramFixture {
  readonly home: string;
  readonly commands: readonly string[];
  readonly appEnvironment: AppEnvironment;
  readonly operations: ReturnType<typeof createSourceOperations>;
  readonly apps: ReturnType<typeof createAppOperations>;
  setLive(version: string): void;
  setTap(version: string): void;
}

async function engramFixture(t: TestContext, live: string, tap: string): Promise<EngramFixture> {
  const home = await mkdtemp(path.join(tmpdir(), "engram-repro-"));
  const stateDirectory = path.join(home, "state");
  const recipesDirectory = path.join(stateDirectory, "apps");
  await mkdir(recipesDirectory, { recursive: true });
  const recipeFile = path.join(recipesDirectory, "engram-linux.json");
  await writeFile(recipeFile, JSON.stringify(RECIPE));
  let liveVersion = live;
  let tapVersion = tap;
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = {
    homeDirectory: home,
    recipesDirectory,
    resolveExecutable: async (name) => `/usr/local/bin/${name}`,
    fetch: async () => { throw new Error("Engram reads channel metadata, never HTTP"); },
    runner: async (_executable, args) => {
      commands.push(args.join(" "));
      const output = args[0] === "version"
        ? `engram ${liveVersion}\n`
        : args[0] === "info"
          ? JSON.stringify({ formulae: [{ name: "engram", versions: { stable: tapVersion, head: null, bottle: true } }] })
          : args[0] === "upgrade"
            // Homebrew auto-updates the tap before upgrade, so the local metadata moves too.
            ? (tapVersion = UPSTREAM_RELEASE, liveVersion = UPSTREAM_RELEASE, "")
            : "";
      return { code: 0, signal: null, stdout: Buffer.from(output), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  const [entry] = await apps.load();
  await apps.approve(entry!);
  const canonicalFile = await realpath(recipeFile);
  await mkdir(path.join(stateDirectory, "app-installations"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(stateDirectory, "app-installations", `${createHash("sha256").update("engram").digest("hex")}.json`),
    JSON.stringify({ name: "engram", recipeFile: canonicalFile, installedVersion: RECORDED_VERSION }),
  );
  t.after(async () => { await rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  return {
    home,
    commands,
    appEnvironment,
    operations: createSourceOperations({ homeDirectory: home, statePath: path.join(stateDirectory, "sources.json") }),
    apps,
    setLive: (version) => { liveVersion = version; },
    setTap: (version) => { tapVersion = version; },
  };
}

const selectedLine = (frame: string | undefined) => (frame ?? "").split("\n").find((line) => line.startsWith("> ")) ?? "";

/** `j` until the selected row is the Engram App row. */
async function highlightEngram(view: ReturnType<typeof render>): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    if (/engram/.test(selectedLine(view.lastFrame()))) return;
    const before = view.lastFrame();
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, (frame) => frame !== before);
  }
  assert.fail(`selection never reached the Engram App row:\n${view.lastFrame()}`);
}

test("repro: Installations shows the recorded 3.0.0 and only reveals live 3.1.0 when the row is highlighted", async (t) => {
  const fixture = await engramFixture(t, LIVE_AFTER_MANUAL_UPDATE, UPSTREAM_RELEASE);
  const view = await renderExpanded(
    <InstallationsView
      operations={fixture.operations}
      environment={{ homeDirectory: fixture.home, projectRoot: fixture.home, appEnvironment: fixture.appEnvironment }}
      listHeight={20}
    />,
  );
  t.after(() => { view.unmount(); view.cleanup(); });
  const listed = await waitForFrame(view.lastFrame, (frame) => frame.includes("Apps (user-global)") && /engram\s+3\.0\.0/.test(frame));
  // The row shows tracked state, not the binary: no version command has run yet.
  assert.deepEqual(fixture.commands, []);
  assert.doesNotMatch(listed, /3\.1\.0/, "the listed Apps row already shows the live version");

  await highlightEngram(view);
  const checked = await waitForFrame(view.lastFrame, (frame) => /engram\s+3\.1\.0/.test(frame));
  assert.deepEqual(fixture.commands, ["version"]);
  assert.match(checked, /engram\s+3\.1\.0/);
});

test("red: the Installations row must not present unverified recorded evidence as the installed version", async (t) => {
  const fixture = await engramFixture(t, LIVE_AFTER_MANUAL_UPDATE, UPSTREAM_RELEASE);
  const view = await renderExpanded(
    <InstallationsView
      operations={fixture.operations}
      environment={{ homeDirectory: fixture.home, projectRoot: fixture.home, appEnvironment: fixture.appEnvironment }}
      listHeight={20}
    />,
  );
  t.after(() => { view.unmount(); view.cleanup(); });
  const listed = await waitForFrame(view.lastFrame, (frame) => frame.includes("Apps (user-global)") && /engram/.test(frame));
  assert.deepEqual(fixture.commands, []);
  // Spec: "Cached tracking is not fresh version evidence" (.scratch/apps/spec.md, ticket 06).
  // Either show the checked version here, or mark this one as recorded rather than verified.
  assert.match(listed, /engram\s+(?:3\.1\.0|3\.0\.0\s*\(?(?:recorded|unverified))/i,
    "the row shows an unverified recorded version with nothing distinguishing it from a checked one");
});

test("repro: the update check offers nothing while the local tap says 3.0.0, and offers 3.1.0 once the tap is refreshed", async (t) => {
  const fixture = await engramFixture(t, RECORDED_VERSION, RECORDED_VERSION);
  const view = render(
    <UpdatesView
      operations={fixture.operations}
      environment={{ homeDirectory: fixture.home, projectRoot: fixture.home, appEnvironment: fixture.appEnvironment }}
    />,
  );
  t.after(() => { view.unmount(); view.cleanup(); });
  const stale = await waitForFrame(view.lastFrame, (frame) => frame.includes("1 up to date"));
  // The user's symptom: the release 3.1.0 exists, and nothing is offered.
  assert.doesNotMatch(stale, /3\.1\.0/);
  assert.doesNotMatch(stale, /App: engram/);
  assert.ok(fixture.commands.some((command) => command.startsWith("info --formula")), "the check read channel metadata");
  assert.ok(!fixture.commands.some((command) => command.startsWith("upgrade")), "the check never ran the update");

  // Something else refreshed the tap (the user's manual `brew upgrade`) while the install stayed 3.0.0.
  fixture.setTap(UPSTREAM_RELEASE);
  const before = view.lastFrame();
  view.stdin.write("r");
  await waitForFrame(view.lastFrame, (frame) => frame !== before);
  const offered = await waitForFrame(view.lastFrame, (frame) => frame.includes("3.0.0 -> 3.1.0"));
  assert.match(offered, /App: engram/);
});

test("red: an update check must not report up to date while the App's release channel names a newer version", async (t) => {
  const fixture = await engramFixture(t, RECORDED_VERSION, RECORDED_VERSION);
  const view = render(
    <UpdatesView
      operations={fixture.operations}
      environment={{ homeDirectory: fixture.home, projectRoot: fixture.home, appEnvironment: fixture.appEnvironment }}
    />,
  );
  t.after(() => { view.unmount(); view.cleanup(); });
  // The tap's origin/main formula is 3.1.0 (upstream truth); the local checkout still reads 3.0.0.
  const frame = await waitForFrame(view.lastFrame, (next) => next.includes("up to date") || next.includes("App: engram"));
  assert.match(frame, /3\.0\.0 -> 3\.1\.0/,
    "Agent Depot read lagging local tap metadata and reported up to date while the release existed");
});

test("facts the diagnosis rests on: comparator, and that only the recipe's own commands run", async (t) => {
  assert.equal(compareAppVersions(RECORDED_VERSION, UPSTREAM_RELEASE), -1);
  assert.equal(sameAppVersion(RECORDED_VERSION, UPSTREAM_RELEASE), false);

  const fixture = await engramFixture(t, RECORDED_VERSION, RECORDED_VERSION);
  const [entry] = await fixture.apps.load();
  const check = await fixture.apps.checkUpdate(entry!);
  assert.equal(check.status, "current");
  assert.equal(check.installedVersion, RECORDED_VERSION);
  assert.equal(check.latestVersion, RECORDED_VERSION);
  assert.deepEqual(fixture.commands, [
    "version",
    "info --formula --json=v2 gentleman-programming/tap/engram",
  ]);
});
