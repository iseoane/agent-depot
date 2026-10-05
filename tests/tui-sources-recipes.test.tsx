import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { SourcesView, type SourcesViewProps } from "../src/tui/sources-view.js";
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
  const fetches: string[] = [];
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory: directory, platform: "linux",
    resolveExecutable: async name => `/usr/bin/${name}`,
    runner: async (_exe, args) => { commands.push(args.join(" ")); throw new Error("No recipe command should run"); },
    fetch: async () => { fetches.push("latest"); throw new Error("No latest lookup should run"); } };
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") });
  t.after(() => rm(home, { recursive: true, force: true }));
  const mount = (listHeight?: number, onOpenCatalog?: SourcesViewProps["onOpenCatalog"]) => {
    const view = render(
      <SourcesView
        onOpenCatalog={onOpenCatalog}
        listHeight={listHeight}
        operations={operations}
        environment={{ homeDirectory: home, projectRoot: home, appEnvironment }}
      />,
    );
    t.after(() => view.unmount());
    return view;
  };
  return { mount, directory, file, commands, fetches, apps: createAppOperations(appEnvironment), operations, home };
}

test("Sources lists every recipe status and path without running commands or fetching latest", async t => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ ...recipe, latest: { npm: "demo" } }));
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
  assert.deepEqual(f.fetches, []);
});

test("Enter previews every step; only y approves and changed content needs approval again", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
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
  await waitForFrame(view.lastFrame, /approved/);
  await writeFile(f.file, JSON.stringify({ ...recipe, homepage: "https://example.com" }));
  view.stdin.write("r");
  frame = await waitForFrame(view.lastFrame, /needs approval/);
  assert.deepEqual(f.commands, []);
  assert.match(frame, /ID\s+KIND/);
});

test("recipe add guide offers exactly AI and manual routes, and AI reuses confirmed Skill installation", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
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
  await f.operations.addGitSource("https://github.com/example/skills.git");
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, /> .*demo.*app/);
  await rm(f.directory, { recursive: true });
  await writeFile(f.directory, "not a directory");
  view.stdin.write("r");
  const frame = await waitForFrame(view.lastFrame, /Error loading App recipes/);
  assert.match(frame, /builtin:agent-depot\s+skills\s+included/);
  view.stdin.write("kn1");
  await waitForFrame(view.lastFrame, /URL:/);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, frame => !frame.includes("URL:"));
});

test("recipe changes after preview and foreign-platform recipes cannot be approved", async t => {
  const f = await fixture(t);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
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
  const startup = await waitForFrame(view.lastFrame, frame => frame.includes("needs approval") && frame.includes("Enter preview/approve"));
  assert.match(startup.split("\n").at(-1) ?? "", /Enter preview\/approve/);
  assert.doesNotMatch(startup, /Tab section/);
  view.stdin.write("n2q");
  const frame = await waitForFrame(view.lastFrame, /agent-depot app schema/);
  assert.match(frame, /\[1 Sources\]/);
  assert.equal(exited, false);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, frame => !frame.includes("agent-depot app schema"));
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[2 Catalog\]/);
});

test("core approval status is explicit and reads no executables, commands or latest", async t => {
  const f = await fixture(t);
  const apps = createAppOperations({ recipesDirectory: f.directory, homeDirectory: f.home,
    resolveExecutable: async () => { assert.fail("approval status must not resolve executables"); },
    runner: async () => { assert.fail("approval status must not run commands"); },
    fetch: async () => { assert.fail("approval status must not fetch latest"); } });
  const [entry] = await apps.load();
  assert.equal((await apps.approvalStatus(entry!)).status, "needs approval");
  await apps.approve(entry!);
  assert.equal((await apps.approvalStatus(entry!)).status, "approved");
  await writeFile(f.file, JSON.stringify({ ...recipe, homepage: "https://example.com" }));
  assert.equal((await apps.approvalStatus(entry!)).status, "needs approval");
  await writeFile(f.file, "{}");
  assert.equal((await apps.approvalStatus((await apps.load())[0]!)).status, "invalid");
  await writeFile(f.file, JSON.stringify({ ...recipe, platform: process.platform === "win32" ? "linux" : "windows" }));
  assert.equal((await apps.approvalStatus((await apps.load())[0]!)).status, "not applicable here");
});

test("Git Sources and recipes share one bounded list and cursor without Tab", async t => {
  const f = await fixture(t);
  await rm(f.file);
  for (let i = 0; i < 20; i++) {
    await f.operations.addGitSource(`https://github.com/example/skills-${i}.git`);
    const name = `app-${String(i).padStart(2, "0")}`;
    await writeFile(path.join(f.directory, `${name}.json`), JSON.stringify({ ...recipe, name }));
  }
  const view = f.mount(6);
  let frame = await waitForFrame(view.lastFrame, /1–6 of 40/);
  const listed = (frame: string) => frame.split("\n").filter(line => /skills-\d+\.git|app-\d+\.json/.test(line));
  assert.equal(listed(frame).length, 6, frame);
  view.stdin.write("j".repeat(39));
  frame = await waitForFrame(view.lastFrame, /> .*app-19.*app/);
  assert.equal(listed(frame).length, 6);
  assert.match(frame, /35–40 of 40/);
  view.stdin.write("n");
  frame = await waitForFrame(view.lastFrame, /1 With the AI skill/);
  assert.equal(listed(frame).length, 6);
});

test("invalid recipes cannot open approval and moving the cursor clears action errors", async t => {
  const f = await fixture(t);
  await writeFile(f.file, "{}");
  await f.operations.addGitSource("https://github.com/example/skills.git");
  const view = f.mount();
  await waitForFrame(view.lastFrame, /invalid recipe:/);
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, /> .*demo.json.*app/);
  view.stdin.write("\r");
  const frame = await waitForFrame(view.lastFrame, frame => frame.split("\n").filter(line => line.includes("expected non-empty text")).length >= 2);
  assert.doesNotMatch(frame, /Approve demo/);
  view.stdin.write("k");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").filter(line => line.includes("expected non-empty text")).length === 1);
  assert.deepEqual(f.commands, []);
});

test("an unmanaged recipe Skill skips installation and goes straight to the agent prompt", async t => {
  const f = await fixture(t);
  const skillDirectory = path.join(f.home, ".agents", "skills", "agent-depot-apprecipe");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: agent-depot-apprecipe\ndescription: Existing recipe helper\n---\n");
  const view = f.mount();
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("n1");
  const frame = await waitForFrame(view.lastFrame, /Use the agent-depot-apprecipe skill/);
  assert.doesNotMatch(frame, /Install agent-depot-apprecipe/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  assert.deepEqual(f.commands, []);
});

test("one cursor dispatches contextual actions for Skill Sources and App recipes", async t => {
  const f = await fixture(t);
  const source = await f.operations.addGitSource("https://github.com/example/skills.git");
  const opened: string[] = [];
  const view = f.mount(undefined, source => { opened.push(source.id); });
  await waitForFrame(view.lastFrame, /needs approval/);
  view.stdin.write("j");
  let frame = await waitForFrame(view.lastFrame, /> .*demo.*app/);
  assert.doesNotMatch(frame, /> \[.\] git:/);
  view.stdin.write(" a");
  view.stdin.write("\r");
  frame = await waitForFrame(view.lastFrame, /Approve demo\? y\/n/);
  assert.doesNotMatch(frame, /selected|remove Git Source/);
  assert.deepEqual(opened, []);
  assert.ok((await f.operations.listSources()).some(item => item.id === source.id));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => !frame.includes("Approve demo?"));
  view.stdin.write("k");
  await waitForFrame(view.lastFrame, /> \[ \] git:/);
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, /1 selected/);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, frame => !frame.includes("1 selected"));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, () => opened.length > 0);
  assert.deepEqual(opened, [source.id]);
  view.stdin.write("d");
  await waitForFrame(view.lastFrame, /remove Git Source/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Removed Git Source/);
  assert.ok(!(await f.operations.listSources()).some(item => item.id === source.id));
});

for (const stage of ["host", "scope", "version", "confirm"] as const) {
  for (const cancel of ["n", "\u001b"]) {
    test(`${cancel === "n" ? "n" : "Esc"} cancels recipe Skill installation at ${stage} without installing`, async t => {
      const f = await fixture(t);
      const view = f.mount();
      await waitForFrame(view.lastFrame, /needs approval/);
          view.stdin.write("n1");
      await waitForFrame(view.lastFrame, /Install agent-depot-apprecipe. Host/);
      if (stage !== "host") {
        view.stdin.write("1");
        view.stdin.write("\r");
        await waitForFrame(view.lastFrame, /Scope:/);
      }
      if (stage === "version" || stage === "confirm") {
        view.stdin.write("2");
        await waitForFrame(view.lastFrame, /Version:/);
      }
      if (stage === "confirm") {
        view.stdin.write("1");
        await waitForFrame(view.lastFrame, /Install agent-depot-apprecipe\? y\/n/);
      }
      view.stdin.write(cancel);
      await waitForFrame(view.lastFrame, /Install cancelled/);
      assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
      // n now opens the recipe guide again, proving cancellation returned to browse.
      view.stdin.write("n");
      await waitForFrame(view.lastFrame, /1 With the AI skill/);
      assert.deepEqual(f.commands, []);
    });
  }
}


test("n can add the first App recipe and closing the guide reloads the unified list", async t => {
  const f = await fixture(t);
  await rm(f.file);
  const view = f.mount();
  await waitForFrame(view.lastFrame, /No sources or App recipes/);
  view.stdin.write("n2");
  await waitForFrame(view.lastFrame, /1 With the AI skill/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /agent-depot app schema/);
  await writeFile(f.file, JSON.stringify(recipe));
  view.stdin.write("\u001b");
  const frame = await waitForFrame(view.lastFrame, /needs approval/);
  assert.match(frame, /> .*demo.*app/u);
  assert.deepEqual(f.commands, []);
});
