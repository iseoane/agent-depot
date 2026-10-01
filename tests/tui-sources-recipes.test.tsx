import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const recipe = { name: "demo", install: { argv: ["demo", "install"] }, update: { manual: "update demo" },
  uninstall: { argv: ["demo", "remove"] }, version: { argv: ["demo", "version"], pattern: "(.*)" },
  latest: { argv: ["demo", "latest"], pattern: "(.*)" }, setup: { pi: { argv: ["demo", "setup"] } } };

async function fixture(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "sources-recipes-"));
  const directory = path.join(home, "state", "apps");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "demo.json");
  await writeFile(file, JSON.stringify(recipe));
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory: directory, platform: "linux",
    resolveExecutable: async name => `/usr/bin/${name}`,
    runner: async (_exe, args) => { commands.push(args.join(" ")); throw new Error("No recipe command should run"); },
    fetch: async () => { throw new Error("No latest lookup should run"); } };
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") });
  t.after(() => rm(home, { recursive: true, force: true }));
  const mount = () => {
    const view = render(<SourcesView operations={operations} environment={{ homeDirectory: home, projectRoot: home, appEnvironment }} />);
    t.after(() => view.unmount());
    return view;
  };
  return { mount, directory, file, commands, apps: createAppOperations(appEnvironment), operations, home };
}

test("Sources lists every recipe status and path without running commands", async t => {
  const f = await fixture(t);
  const [entry] = await f.apps.load();
  await f.apps.approve(entry!);
  await writeFile(path.join(f.directory, "new.json"), JSON.stringify({ ...recipe, name: "new" }));
  await writeFile(path.join(f.directory, "windows.json"), JSON.stringify({ ...recipe, platform: "windows" }));
  await writeFile(path.join(f.directory, "invalid.json"), "{}");
  const view = f.mount();
  const frame = await waitForFrame(view.lastFrame, /not applicable here/);
  assert.match(frame, /demo.json.*approved/);
  assert.match(frame, /new.json.*needs approval/);
  assert.match(frame, /invalid.json.*invalid recipe:/);
  assert.ok(frame.includes(f.directory));
  assert.match(frame, /builtin:agent-depot/);
  assert.deepEqual(f.commands, []);
});

test("Enter previews every step; only y approves and changed content needs approval again", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("\t");
  view.stdin.write("\r");
  let frame = await waitForFrame(view.lastFrame, /Approve demo\? y\/n/);
  for (const step of ["install", "remove", "version", "latest", "setup"]) assert.ok(frame.includes(`["demo","${step}"]`), frame);
  assert.ok(frame.includes(f.file));
  assert.match(frame, /Platform: all/);
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => !frame.includes("Approve demo?"));
  assert.equal((await f.apps.inspect((await f.apps.load())[0]!, {})).status, "needs approval");
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Approve demo\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /demo.json · approved/);
  await writeFile(f.file, JSON.stringify({ ...recipe, homepage: "https://example.com" }));
  view.stdin.write("r");
  frame = await waitForFrame(view.lastFrame, /needs approval/);
  assert.deepEqual(f.commands, []);
  assert.match(frame, /App recipes/);
});

test("recipe add guide offers exactly AI and manual routes, and AI reuses confirmed Skill installation", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("\t");
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /1 With the AI skill/);
  view.stdin.write("2");
  let frame = await waitForFrame(view.lastFrame, /agent-depot app schema/);
  assert.ok(frame.includes(f.directory));
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, frame => !frame.includes("agent-depot app schema"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /1 With the AI skill/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /Install agent-depot-apprecipe. Host/);
  view.stdin.write("1");
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Scope/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /Version/);
  view.stdin.write("1");
  frame = await waitForFrame(view.lastFrame, /Install.*y\/n/);
  assert.match(frame, /agent-depot-apprecipe/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Use the agent-depot-apprecipe skill to create the recipe for <app>/);
  assert.equal((await f.operations.listUserGlobalInstallations!())[0]?.path, "agent-depot-apprecipe");
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, frame => !frame.includes("Use the agent-depot-apprecipe"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /1 With the AI skill/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /Use the agent-depot-apprecipe skill/);
  assert.deepEqual(f.commands, []);
});

test("recipe reload failures stay local and Git Source add keys remain usable", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
  await rm(f.directory, { recursive: true });
  await writeFile(f.directory, "not a directory");
  view.stdin.write("\t");
  view.stdin.write("r");
  const frame = await waitForFrame(view.lastFrame, /Error loading App recipes/);
  assert.match(frame, /builtin:agent-depot · included/);
  view.stdin.write("\t");
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /URL:/);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, frame => !frame.includes("URL:"));
});

test("recipe changes after preview and foreign-platform recipes cannot be approved", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("\t");
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Approve demo\? y\/n/);
  await writeFile(f.file, JSON.stringify({ ...recipe, platform: "windows" }));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Recipe changed, invalid or not applicable/);
  view.stdin.write("r");
  await waitForFrame(view.lastFrame, /not applicable here/);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Platform: windows/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("Recipe changed, invalid or not applicable") && !frame.includes("Approve demo?"));
  assert.equal((await f.apps.inspect((await f.apps.load())[0]!, {})).status, "not applicable here");
  assert.deepEqual(f.commands, []);
});


test("recipe guide captures global number and quit keys in the shell", async t => {
  const f = await fixture(t);
  let exited = false;
  const view = render(<App operations={f.operations} environment={{ homeDirectory: f.home, projectRoot: f.home,
    appEnvironment: { recipesDirectory: f.directory, homeDirectory: f.home } }} onExit={() => { exited = true; }} />);
  t.after(() => view.unmount());
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("\t");
  view.stdin.write("n2q");
  const frame = await waitForFrame(view.lastFrame, /agent-depot app schema/);
  assert.match(frame, /\[1 Sources\]/);
  assert.equal(exited, false);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, frame => !frame.includes("agent-depot app schema"));
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[2 Catalog\]/);
});
