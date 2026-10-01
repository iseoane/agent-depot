import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { createAppOperations } from "../src/app-flow.js";
import { parseProfile } from "../src/profile.js";
import { createSourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { ProfileView } from "../src/tui/profile-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const recipe = { name: "demo", install: { manual: "Install demo" }, update: { manual: "Update demo" },
  uninstall: { manual: "Remove demo" }, version: { argv: ["demo", "version"], pattern: "(.*)" } };
async function fixture(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "profile-tui-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const environment = { homeDirectory: home, appEnvironment: { recipesDirectory: directory,
    runner: async () => { throw new Error("Recipes must not execute"); } } };
  const view = render(<App operations={operations} environment={environment} />);
  t.after(() => { view.unmount(); return rm(home, { recursive: true, force: true }); });
  await waitForFrame(view.lastFrame, /builtin:agent-depot/);
  view.stdin.write("5");
  await waitForFrame(view.lastFrame, /e export.*i import/);
  return { home, directory, operations, environment, view };
}

test("export shows grouped choices and exclusions, confirms a new file and refuses replacement", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  const checklist = await waitForFrame(f.view.lastFrame, /Apps: demo/);
  assert.match(checklist, /\[x\].*Apps: demo/);
  assert.match(checklist, /Excluded built-in Source[\s\S]*not\s+selectable/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Profile path:/);
  const file = path.join(f.home, "out.json");
  f.view.stdin.write(file);
  await waitForFrame(f.view.lastFrame, frame => frame.includes(file));
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Apply Profile/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Exported profile to/);
  assert.equal(parseProfile(JSON.parse(await readFile(file, "utf8"))).apps[0]?.name, "demo");
  const original = await readFile(file, "utf8");
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Apps: demo/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Profile path:/);
  f.view.stdin.write(file);
  await waitForFrame(f.view.lastFrame, frame => frame.includes(file));
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Apply Profile/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /already exists; choose another path/);
  assert.equal(await readFile(file, "utf8"), original);
});

test("import warns on newer producers, skips conflicts and adds recipes unapproved without commands", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  const file = path.join(f.home, "in.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "99.0.0",
    sources: [], skills: [], apps: [recipe, { ...recipe, name: "second" }] }));
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Profile path:/);
  f.view.stdin.write(file);
  await waitForFrame(f.view.lastFrame, frame => frame.includes(file));
  f.view.stdin.write("\r");
  const checklist = await waitForFrame(f.view.lastFrame, /add: App recipe second/);
  assert.match(checklist, /conflict: App recipe demo[\s\S]*not selectable/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /newer than running/);
  f.view.stdin.write("y");
  const results = await waitForFrame(f.view.lastFrame, /added: App recipe second/);
  assert.match(results, /skipped: App recipe demo/);
  const apps = createAppOperations({ homeDirectory: f.home, ...f.environment.appEnvironment });
  const entry = (await apps.load()).find(entry => entry.recipe?.name === "second");
  assert.ok(entry);
  assert.notEqual(await apps.approvalStatus(entry), "approved");
});

test("invalid import errors remain usable and long export lists are windowed", async t => {
  const f = await fixture(t);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Profile path:/);
  f.view.stdin.write(path.join(f.home, "missing"));
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Error:.*ENOENT/);
  for (let index = 0; index < 20; index++) await writeFile(path.join(f.directory, `${index}.json`), JSON.stringify({ ...recipe, name: `demo-${index}` }));
  const view = render(<ProfileView operations={f.operations} environment={f.environment} listHeight={3} />);
  t.after(() => view.unmount());
  view.stdin.write("e");
  const frame = await waitForFrame(view.lastFrame, /of 21/);
  assert.ok(frame.split("\n").length < 12);
  view.stdin.write("j".repeat(20));
  await waitForFrame(view.lastFrame, /19–21 of 21/);
});

test("import previews recorded method argv and unregistered Sources; declining writes nothing", async t => {
  const f = await fixture(t);
  const file = path.join(f.home, "methods.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "99.0.0",
    sources: [], apps: [], skills: [{ source: { kind: "external", url: "https://github.com/example/skills.git" },
      path: "demo", hosts: ["pi"], version: { policy: "latest" }, methods: { install: { kind: "command", argv: ["demo", "install"] } } }] }));
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Profile path:/);
  f.view.stdin.write(file);
  await waitForFrame(f.view.lastFrame, frame => frame.includes(file));
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /add: Skill demo/);
  f.view.stdin.write("\r");
  const preview = await waitForFrame(f.view.lastFrame, /Apply Profile/);
  assert.match(preview, /argv=\["demo","install"\]/);
  assert.match(preview, /will be fetched but not registered/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, /e export · i import · q quit/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
});

test("export renders real group headers and plain exclusions rather than synthetic App checkboxes", async t => {
  const f = await fixture(t);
  const source = await f.operations.addGitSource("https://example.com/skills.git");
  await f.operations.addUserGlobalInstallation!({
    source: { kind: "external", url: source.url }, path: "demo",
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: ".agents/skills/demo", adopted: false },
  });
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  const frame = await waitForFrame(f.view.lastFrame, /Skills: demo/);
  for (const group of ["Sources", "Skills", "Apps", "Excluded"]) assert.match(frame, new RegExp(`^${group}$`, "m"));
  assert.match(frame, /\[x\].*Sources: https:\/\/example.com\/skills.git/);
  assert.match(frame, /\[x\].*Skills: demo/);
  assert.doesNotMatch(frame, /\[ \].*Excluded built-in/);
});

test("space and all toggle export choices; an empty selection stops before the file prompt", async t => {
  const f = await fixture(t);
  await f.operations.addGitSource("https://example.com/skills.git");
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /\[x\].*Sources:/);
  f.view.stdin.write(" ");
  const partial = await waitForFrame(f.view.lastFrame, /\[ \].*Sources:/);
  assert.match(partial, /\[x\].*Apps: demo/);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[ \].*Apps: demo/);
  f.view.stdin.write("a");
  const all = await waitForFrame(f.view.lastFrame, /\[x\].*Sources:/);
  assert.match(all, /\[x\].*Apps: demo/);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[ \].*Apps: demo/);
  f.view.stdin.write("\r");
  const empty = await waitForFrame(f.view.lastFrame, /Nothing selected; nothing written/);
  assert.doesNotMatch(empty, /Profile path:|Apply Profile/);
});

test("browse hints do not advertise scrolling; result summaries do", async t => {
  const f = await fixture(t);
  const browse = f.view.lastFrame()!;
  assert.doesNotMatch(browse, /j\/k scroll/);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Excluded built-in/);
  f.view.stdin.write("\r");
  const result = await waitForFrame(f.view.lastFrame, /Nothing selected; nothing written/);
  assert.match(result, /j\/k scroll/);
});
