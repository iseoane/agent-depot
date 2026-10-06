import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { render } from "ink-testing-library";

import { createPackageOperations, type PackageOperations } from "../src/package-flow.js";
import type { ProcessRunOptions, ProcessRunResult } from "../src/process-runner.js";
import { parseProjectManifest, ProjectManifestStore } from "../src/project-manifest.js";
import { createSourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const PORTABLE_URL = "https://example.test/packages/pstack.git";
const PI_IDENTITY = "git:example.test/packages/pstack";
const ENTER = "\r";

/** Never reads the real cwd manifest. */
class EmptyManifestStore extends ProjectManifestStore {
  constructor() {
    super("/nonexistent/agent-depot-test/agent-depot.json");
  }

  override async load() {
    return parseProjectManifest({ version: 1, skills: [] });
  }
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/** The real pstack fixture committed to Git, reached through a URL Git rewrites to the local path. */
const root = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-journey-"));
after(() => rm(root, { recursive: true, force: true }));

const repository = path.join(root, "pstack");
await cp(path.resolve("tests", "fixtures", "packages", "pstack"), repository, { recursive: true });
const gitConfig = path.join(root, "gitconfig");
await writeFile(gitConfig, `[url "file://${repository}"]\n\tinsteadOf = ${PORTABLE_URL}\n[protocol "file"]\n\tallow = always\n[user]\n\tname = journey\n\temail = journey@example.test\n`);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "fixture"]]) {
  execFileSync("git", args, { cwd: repository, stdio: "pipe" });
}

/** A stand-in for the Pi CLI that records argv and leaves the settings entry the real host would write. */
function fakePiRunner(calls: Call[], home: string): (command: string, args: readonly string[], options?: ProcessRunOptions) => Promise<ProcessRunResult> {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (path.basename(command) === "pi" && args[0] === "install") {
      const settings = path.join(home, ".pi", "agent", "settings.json");
      await mkdir(path.dirname(settings), { recursive: true });
      await writeFile(settings, `${JSON.stringify({ packages: [`${PI_IDENTITY}@${"b".repeat(40)}`] }, null, 2)}\n`);
    }
    return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", outputTooLarge: false };
  };
}

interface Journey {
  readonly view: ReturnType<typeof render>;
  readonly calls: Call[];
  readonly packages: PackageOperations;
  readonly home: string;
}

/** Renders the real App over a temp home and the real Source and Package operations. */
async function journey(t: { after(callback: () => void | Promise<void>): void }): Promise<Journey> {
  const base = path.join(root, `journey-${Math.random().toString(16).slice(2)}`);
  const home = path.join(base, "home");
  await mkdir(home, { recursive: true });
  const sources = createSourceOperations({ homeDirectory: home, statePath: path.join(base, "sources.json") });
  const calls: Call[] = [];
  const packages = createPackageOperations({
    homeDirectory: home,
    stateDirectory: path.join(base, "state"),
    platform: "linux",
    isWsl: false,
    sourceOperations: sources,
    resolveExecutable: async (executable) => `/usr/bin/${executable}`,
    runner: fakePiRunner(calls, home),
  });
  const environment: TuiEnvironment = {
    homeDirectory: home,
    projectRoot: home,
    projectManifestStore: new EmptyManifestStore(),
    packages,
  };
  const view = render(<App operations={sources} environment={environment} onExit={() => undefined} />);
  t.after(() => view.unmount());
  return { view, calls, packages, home };
}

type Frame = ReturnType<typeof render>["lastFrame"];

/** Presses j until the selected Catalog line matches, waiting for each move to render. */
async function moveDownTo(lastFrame: Frame, stdin: { write(data: string): void }, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    const line = (lastFrame() ?? "").split("\n").find((candidate) => candidate.startsWith("> ")) ?? "";
    if (line.match(pattern)) return;
    const before = lastFrame();
    stdin.write("j");
    await waitForFrame(lastFrame, (next) => next !== before);
  }
  assert.fail("selection never reached the expected line");
}

test("n adds a Git Source, refresh discovers its Package, and i installs it through the shared flow", async (t) => {
  const j = await journey(t);
  await waitForFrame(j.view.lastFrame, /builtin:agent-depot/);

  j.view.stdin.write("n");
  const chooser = await waitForFrame(j.view.lastFrame, /Add: 1 Git Source \(skills \+ Packages\)/);
  assert.ok(chooser.includes("2 App recipe"));
  j.view.stdin.write("1");
  await waitForFrame(j.view.lastFrame, /URL:/);
  j.view.stdin.write(PORTABLE_URL);
  await waitForFrame(j.view.lastFrame, new RegExp(PORTABLE_URL.replace(/[.]/gu, "\\.")));
  j.view.stdin.write(ENTER);
  await waitForFrame(j.view.lastFrame, /Added Git Source: git:/);
  await waitForFrame(j.view.lastFrame, /j\/k move · space mark/);

  j.view.stdin.write("r");
  await waitForFrame(j.view.lastFrame, /refresh Git Source git:/);
  j.view.stdin.write("y");
  await waitForFrame(j.view.lastFrame, /Refreshed Git Source: git:/);
  await waitForFrame(j.view.lastFrame, /j\/k move · space mark/);

  j.view.stdin.write(ENTER);
  await waitForFrame(j.view.lastFrame, /Scope: git:/);
  j.view.stdin.write(ENTER);
  await waitForFrame(j.view.lastFrame, /Packages \(2\)/);
  await moveDownTo(j.view.lastFrame, j.view.stdin, /> .*Packages \(2\)/);
  j.view.stdin.write(ENTER);
  await waitForFrame(j.view.lastFrame, /Package pstack \(pi\)/);
  await moveDownTo(j.view.lastFrame, j.view.stdin, /> .*Package pstack \(pi\)/);

  j.view.stdin.write("i");
  const preview = await waitForFrame(j.view.lastFrame, /Approve this declaration and continue\? y\/n/);
  assert.match(preview, /Step 1 \(apply\): \["pi","install","git:example\.test\/packages\/pstack"\]/);
  assert.match(preview, /Approval: needs approval/);
  assert.equal(j.calls.length, 0, "the preview runs no host command");
  j.view.stdin.write("y");
  await waitForFrame(j.view.lastFrame, /install pstack\? y\/n/);
  assert.equal(j.calls.length, 0, "the approval gate runs no host command");
  j.view.stdin.write("y");
  await waitForFrame(j.view.lastFrame, /pstack: installed/);

  assert.deepEqual(j.calls.map((call) => [path.basename(call.command), ...call.args]), [
    ["pi", "install", PI_IDENTITY],
  ]);
  const records = await j.packages.list();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.selection.source, { kind: "external", url: PORTABLE_URL });
  const settings = JSON.parse(await readFile(path.join(j.home, ".pi", "agent", "settings.json"), "utf8")) as { packages?: readonly string[] };
  assert.deepEqual(settings.packages, [`${PI_IDENTITY}@${"b".repeat(40)}`], "the fake host recorded the delegated install");
});
