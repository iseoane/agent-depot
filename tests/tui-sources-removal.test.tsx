import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";

import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { waitForFrame } from "./wait-for-frame.js";

async function fixture(t: TestContext, installed = false, failUninstall = false, manual = false) {
  const home = await mkdtemp(path.join(tmpdir(), "sources-removal-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  const file = path.join(directory, "demo.json");
  await writeFile(file, JSON.stringify({ name: "demo", install: { argv: ["demo", "install"] }, update: { manual: "update demo" },
    uninstall: manual ? { manual: "Uninstall demo in your terminal" } : { argv: ["demo", "remove"] },
    version: { argv: ["demo", "version"], pattern: "(1\\.2\\.3)" } }));
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory: directory,
    resolveExecutable: async () => "/bin/demo", runner: async (_command, args) => {
      commands.push(args[0]);
      if (args[0] === "remove") {
        if (failUninstall) return { code: 1, signal: null, stdout: Buffer.from("uninstall failed"), stderr: "", outputTooLarge: false };
        installed = false;
      }
      return { code: args[0] === "version" && !installed ? 1 : 0, signal: null, stdout: Buffer.from(installed ? "1.2.3" : ""), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  const [entry] = await apps.load();
  await apps.approve(entry);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const environment = { homeDirectory: home, projectRoot: home, appEnvironment };
  const view = render(<SourcesView operations={operations} environment={environment} />);
  t.after(async () => { view.unmount(); await rm(home, { recursive: true, force: true }); });
  await waitForFrame(view.lastFrame, /approved/);
  return { view, file, commands, apps, operations, environment, markUninstalled: () => { installed = false; } };
}

test("d removes an uninstalled recipe only after preview and confirmation", async t => {
  const f = await fixture(t);
  f.view.stdin.write("d");
  const preview = await waitForFrame(f.view.lastFrame, /Remove recipe for demo\? y\/n/);
  assert.ok(preview.includes(f.file));
  assert.match(preview, /Only this recipe/u);
  assert.ok(await readFile(f.file));
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, text => !text.includes("Remove recipe for demo?"));
  assert.ok(await readFile(f.file));
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Remove recipe for demo\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Removed App recipe:/);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(f.commands.every(command => command === "version"));
});

test("declining optional uninstall cancels recipe removal", async t => {
  const f = await fixture(t, true);
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Uninstall it before removing the recipe\? y\/n/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, text => !text.includes("Uninstall it before"));
  assert.ok(await readFile(f.file));
  assert.deepEqual(f.commands, ["version"]);
});

test("successful optional uninstall is followed by separate recipe removal confirmation", async t => {
  const f = await fixture(t, true);
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Uninstall it before/);
  f.view.stdin.write("y");
  const preview = await waitForFrame(f.view.lastFrame, /Uninstall demo\? y\/n/);
  assert.match(preview, /\["demo","remove"\]/u);
  assert.ok(!f.commands.includes("remove"));
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Remove recipe for demo\? y\/n/);
  assert.ok(await readFile(f.file));
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Removed App recipe:/);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(f.commands.includes("remove"));
});

test("failed optional uninstall retains the recipe", async t => {
  const f = await fixture(t, true, true);
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Uninstall it before/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Uninstall demo\? y\/n/);
  f.view.stdin.write("y");
  const frame = await waitForFrame(f.view.lastFrame, /recipe retained/);
  assert.match(frame, /uninstall failed/u);
  assert.ok(await readFile(f.file));
});

test("manual uninstall requires attestation and verified absence before recipe deletion", async t => {
  const f = await fixture(t, true, false, true);
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Uninstall it before/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Uninstall demo in your terminal/);
  f.markUninstalled();
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Remove recipe for demo\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Removed App recipe:/);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(f.commands.every(command => command === "version"));
});

test("Sources footer follows a single cursor and hides unsupported recipe mark actions", async t => {
  const f = await fixture(t);
  await f.operations.addGitSource("https://github.com/example/skills.git");
  f.view.unmount();
  const view = render(<App operations={f.operations} environment={f.environment} />);
  t.after(() => view.unmount());
  await waitForFrame(view.lastFrame, text => text.includes("approved") && text.includes("Enter catalog"));
  view.stdin.write("j");
  const appFrame = await waitForFrame(view.lastFrame, /Enter preview\/approve/);
  assert.match(appFrame, /> .*demo.*app/u);
  assert.doesNotMatch(appFrame.split("\n").at(-1) ?? "", /space mark|a all|Tab/u);
  view.stdin.write("k");
  const sourceFrame = await waitForFrame(view.lastFrame, /Enter catalog/);
  assert.match(sourceFrame.split("\n").at(-1) ?? "", /space mark/u);
});


test("removal approval gates version checks before any uninstall or deletion", async t => {
  const f = await fixture(t);
  const declaration = JSON.parse(await readFile(f.file, "utf8"));
  await writeFile(f.file, JSON.stringify({ ...declaration, homepage: "https://example.com" }));
  f.view.stdin.write("r");
  await waitForFrame(f.view.lastFrame, /needs approval/);
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Approve demo\? y\/n/);
  assert.deepEqual(f.commands, []);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, text => !text.includes("Approve demo?"));
  assert.ok(await readFile(f.file));
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Approve demo\? y\/n/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Remove recipe for demo\? y\/n/);
  assert.deepEqual(f.commands, ["version"]);
  assert.ok(await readFile(f.file));
});
