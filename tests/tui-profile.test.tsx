import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { createAppOperations } from "../src/app-flow.js";
import { parseProfile } from "../src/profile.js";
import { GitSourceAccessAdapter } from "../src/git-source.js";
import { createSourceOperations, type SourceOperationsOptions } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { ProfileView } from "../src/tui/profile-view.js";
import { fakePackageOperations, installedPackage, piPackage } from "./profile-package-fixture.js";
import { waitForFrame } from "./wait-for-frame.js";

const recipe = { name: "demo", install: { manual: "Install demo" }, update: { manual: "Update demo" },
  uninstall: { manual: "Remove demo" }, version: { argv: ["demo", "version"], pattern: "(.*)" } };
async function fixture(t: TestContext, sourceOptions: SourceOperationsOptions = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "profile-tui-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json"), ...sourceOptions });
  const environment = { homeDirectory: home, appEnvironment: { recipesDirectory: directory,
    runner: async () => { throw new Error("Recipes must not execute"); } } };
  let exits = 0;
  const view = render(<App operations={operations} environment={environment} onExit={() => { exits++; }} />);
  t.after(() => { view.unmount(); return rm(home, { recursive: true, force: true }); });
  await waitForFrame(view.lastFrame, /builtin:agent-depot/);
  view.stdin.write("5");
  await waitForFrame(view.lastFrame, /e export.*i import/);
  return { home, directory, operations, environment, view, exits: () => exits };
}

test("export shows grouped choices and exclusions, confirms a new file and refuses replacement", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  const checklist = await waitForFrame(f.view.lastFrame, /demo \(all platforms\)/);
  assert.match(checklist, /\[x\] 1 demo \(all platforms\)/);
  assert.match(checklist, /Not transferred because it is always present: built-in Source/);
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
  await waitForFrame(f.view.lastFrame, /demo \(all platforms\)/);
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
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify({ ...recipe, install: { manual: "Keep existing install" } }));
  const file = path.join(f.home, "in.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "99.0.0",
    sources: [], skills: [], apps: [recipe, { ...recipe, name: "second" }] }));
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Profile path:/);
  f.view.stdin.write(file);
  await waitForFrame(f.view.lastFrame, frame => frame.includes(file));
  f.view.stdin.write("\r");
  const checklist = await waitForFrame(f.view.lastFrame, /add: App recipe second/);
  assert.match(checklist.replaceAll("│", ""), /conflict: App recipe demo[\s\S]*not\s+selectable/);
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

for (const [label, content, reason] of [
  ["malformed JSON", "{", /Expected|Unexpected|JSON/],
  ["invalid profile", JSON.stringify({ format: "agent-depot-profile/v9" }), /profile.format/],
  ["schema-invalid profile", JSON.stringify({
    format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [{ url: "https://example.com/skills.git", included: "yes" }], skills: [], apps: [],
  }), /sources\[0\].included/],
] as const) {
  test(`import reports ${label} without writing or losing navigation`, async t => {
    const f = await fixture(t);
    const file = path.join(f.home, "invalid.json");
    await writeFile(file, content);
    const result = await importFile(f.view, file);
    assert.match(result, /^Error: /m);
    assert.doesNotMatch(result, /Apply Profile|add: /);
    assert.match(result, reason);
    assert.deepEqual(await createAppOperations(f.environment.appEnvironment).load(), []);
    assert.equal((await f.operations.listSources()).length, 1);
    f.view.stdin.write("1");
    await waitForFrame(f.view.lastFrame, /▶ \[1\] Sources/);
  });
}

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
  const frame = await waitForFrame(view.lastFrame, /of 23/);
  assert.ok(frame.split("\n").length < 12);
  view.stdin.write("j".repeat(20));
  const scrolled = await waitForFrame(view.lastFrame, frame => frame.includes("of 23") && frame.includes("Export notes"));
  assert.match(scrolled, /of 23/);
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
  const frame = await waitForFrame(f.view.lastFrame, /\[x\] 1 demo/);
  for (const group of ["Sources", "Skills", "Apps", "Export notes"]) assert.match(frame, new RegExp(`^.*${group} \\(`, "m"));
  assert.match(frame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  assert.match(frame, /\[x\] 1 demo/);
  assert.match(frame, /Not transferred because it is always present: built-in Source/);
  assert.doesNotMatch(frame, /\[ \].*Not transferred/);
});

test("export panel stays inside a resized terminal with wrapped choices and confirmation chrome", async t => {
  const f = await fixture(t);
  const url = `https://example.com/${"long-path-segment/".repeat(8)}skills.git`;
  await f.operations.addGitSource(url);
  const unmanaged = path.join(f.home, ".agents", "skills", `${"very-long-unmanaged-name-".repeat(3)}skill`);
  await mkdir(unmanaged, { recursive: true });
  await writeFile(path.join(unmanaged, "SKILL.md"), "---\nname: unmanaged\ndescription: fixture\n---\n");
  const view = f.view;
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 17 });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 40 });
  view.stdout.emit("resize");
  view.stdin.write("e");
  let frame = await waitForFrame(view.lastFrame, /Export Profile/);
  assert.ok(frame.split("\n").length <= 17, frame);
  assert.match(frame, /Export Profile/);
  assert.match(frame, /…/);
  assert.match(frame, /preview shows full text/);
  for (let index = 0; index < 12 && !frame.replace(/[│\s]/g, "").includes("very-long-unmanaged-name-"); index++) {
    const before = frame;
    view.stdin.write("j");
    frame = await waitForFrame(view.lastFrame, next => next !== before);
  }
  assert.ok(frame.split("\n").length <= 17, frame);
  assert.ok(frame.replace(/[│\s]/g, "").includes("very-long-unmanaged-name-"), frame);
  assert.match(frame, /preview shows full text/);
  assert.ok(frame.split("\n").some(line => line.includes(">") && line.includes("very-long")), frame);
  view.stdin.write("\r");
  const detail = await waitForFrame(view.lastFrame, /Export note/);
  assert.ok(detail.split("\n").length <= 17, detail);
  assert.match(detail, /Excluded unmanaged Skill/);
  view.stdin.write("j".repeat(12));
  const detailTail = await waitForFrame(view.lastFrame, /not tracked/);
  assert.ok(detailTail.split("\n").length <= 17, detailTail);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, /Export Profile/);
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 24 });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 80 });
  view.stdout.emit("resize");
  frame = await waitForFrame(view.lastFrame, frame => frame.includes("Export notes") &&
    frame.split("\n").some(line => line.startsWith("╭") && line.length === 80));
  assert.ok(frame.split("\n").length <= 24, frame);
  assert.ok(frame.replace(/[│\s]/g, "").includes(`${"very-long-unmanaged-name-".repeat(3)}skill`), frame);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, /e export · i import/);
  view.stdin.write("e");
  frame = await waitForFrame(view.lastFrame, frame => frame.replace(/[│\s]/g, "").includes(url.replace(/[│\s]/g, "")));
  assert.ok(frame.split("\n").length <= 24, frame);
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 17 });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 40 });
  view.stdout.emit("resize");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("╭") && line.length === 40));
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, /e export · i import/);
  view.stdin.write("e");
  const narrowExport = await waitForFrame(view.lastFrame, /Export Profile/);
  assert.match(narrowExport, /…/);
  view.stdin.write("\r");
  const prompt = await waitForFrame(view.lastFrame, /Profile path/);
  assert.ok(prompt.split("\n").length <= 17, prompt);
  assert.match(prompt, /Enter submit · Esc cancel/);
  view.stdin.write(path.join(f.home, "review.json"));
  await waitForFrame(view.lastFrame, /review.json/);
  view.stdin.write("\r");
  const confirmation = await waitForFrame(view.lastFrame, /Apply Profile/);
  assert.ok(confirmation.split("\n").length <= 17, confirmation);
  assert.match(confirmation, /arrows\/PgUp\/PgDn page/);
  assert.doesNotMatch(confirmation, /Export Profile|Portable Profile/);
});

test("export group selection and numbering survive scrolling, collapse, expansion and resize", async t => {
  const f = await fixture(t);
  const source = await f.operations.addGitSource("https://example.com/stable.git");
  for (let index = 1; index <= 6; index++) await f.operations.addUserGlobalInstallation!({
    source: { kind: "external", url: source.url }, path: `skill-${index}`,
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: `.agents/skills/skill-${index}`, adopted: false },
  });
  const view = render(<ProfileView operations={f.operations} environment={f.environment} listHeight={4} />);
  t.after(() => view.unmount());
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /Skills \(6\)/);
  const step = async (key: string) => {
    const before = view.lastFrame();
    view.stdin.write(key);
    return waitForFrame(view.lastFrame, frame => frame !== before);
  };
  let frame = view.lastFrame() ?? "";
  for (let index = 0; index < 12 && !/> \[x\] 4 skill-4/.test(frame); index++) frame = await step("j");
  assert.match(frame, /> \[x\] 4 skill-4/);
  frame = await step(" ");
  assert.match(frame, /> \[ \] 4 skill-4/);
  for (let index = 0; index < 12 && !/> ▾ Skills/.test(frame); index++) frame = await step("k");
  assert.match(frame, /> ▾ Skills/);
  const collapsed = await step("\r");
  assert.match(collapsed, /▸ Skills \(6\)/);
  assert.doesNotMatch(collapsed, /skill-4/);
  view.stdin.write("\r");
  let expanded = await waitForFrame(view.lastFrame, /▾ Skills \(6\)/);
  for (let index = 0; index < 8 && !/\[ \] 4 skill-4/.test(expanded); index++) expanded = await step("j");
  assert.match(expanded, /\[ \] 4 skill-4/);
  for (let index = 0; index < 8 && !/\[x\] 6 skill-6/.test(expanded); index++) expanded = await step("j");
  assert.match(expanded, /\[x\] 6 skill-6/);
});

test("Packages appear in the export checklist and import previews the recorded selection", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "profile-tui-packages-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const { operations: exporter } = fakePackageOperations({ recorded: [installedPackage] });
  const view = render(<ProfileView operations={operations} environment={{ homeDirectory: home, packages: exporter }} />);
  t.after(() => view.unmount());
  view.stdin.write("e");
  const checklist = await waitForFrame(view.lastFrame, /Package pi plugins\/demo/);
  assert.match(checklist, /\[x\] 1 Package pi plugins\/demo \(latest\)/);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Profile path:/);
  const file = path.join(home, "out.json");
  view.stdin.write(file);
  await waitForFrame(view.lastFrame, frame => frame.includes(file));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Apply Profile/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Exported profile to/);
  const exported = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(parseProfile(exported).packages, [piPackage]);

  const input = path.join(home, "in.json");
  await writeFile(input, JSON.stringify({ ...exported, sources: [], skills: [], apps: [] }));
  const { operations: importer, evidence } = fakePackageOperations({});
  const importing = render(<ProfileView operations={operations} environment={{ homeDirectory: home, packages: importer }} />);
  t.after(() => importing.unmount());
  importing.stdin.write("i");
  await waitForFrame(importing.lastFrame, /Profile path:/);
  importing.stdin.write(input);
  await waitForFrame(importing.lastFrame, frame => frame.includes(input));
  importing.stdin.write("\r");
  await waitForFrame(importing.lastFrame, /add: Package pi plugins\/demo/);
  importing.stdin.write("\r");
  const preview = await waitForFrame(importing.lastFrame, /Apply Profile/);
  assert.match(preview, /select records the choice; it runs no host command/);
  importing.stdin.write("y");
  await waitForFrame(importing.lastFrame, /added: Package pi plugins\/demo/);
  assert.deepEqual(evidence.plans, ["select"]);
  assert.deepEqual(evidence.approvals, ["select"]);
  assert.deepEqual(evidence.executions, [{ action: "select", confirmed: true }]);
});

test("space and all toggle export choices; an empty selection stops before the file prompt", async t => {
  const f = await fixture(t);
  await f.operations.addGitSource("https://example.com/skills.git");
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  f.view.stdin.write(" ");
  const partial = await waitForFrame(f.view.lastFrame, /\[ \] 1 https:\/\/example.com\/skills.git/);
  assert.match(partial, /\[x\] 1 demo \(all platforms\)/);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[ \] 1 demo \(all platforms\)/);
  f.view.stdin.write("a");
  const all = await waitForFrame(f.view.lastFrame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  assert.match(all, /\[x\] 1 demo \(all platforms\)/);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[ \] 1 demo \(all platforms\)/);
  f.view.stdin.write("\r");
  const empty = await waitForFrame(f.view.lastFrame, /Nothing selected; nothing written/);
  assert.doesNotMatch(empty, /Profile path:|Apply Profile/);
});

test("browse hints do not advertise scrolling; result summaries do", async t => {
  const f = await fixture(t);
  const browse = f.view.lastFrame()!;
  assert.doesNotMatch(browse, /j\/k scroll/);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Not transferred because it is always present/);
  f.view.stdin.write("\r");
  const result = await waitForFrame(f.view.lastFrame, /Nothing selected; nothing written/);
  assert.match(result, /j\/k scroll/);
});


async function importFile(view: ReturnType<typeof render>, file: string): Promise<string> {
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, /Profile path: _/);
  // Deliberately paste the entire path in one event, rather than typing character by character.
  view.stdin.write(file);
  await waitForFrame(view.lastFrame, frame => frame.includes(`Profile path: ${file}_`));
  view.stdin.write("\r");
  return waitForFrame(view.lastFrame, frame => !frame.includes("Profile path:") && !frame.includes("Loading Profile"));
}

async function browse(view: ReturnType<typeof render>): Promise<string> {
  return waitForFrame(view.lastFrame, frame => frame.includes("e export · i import · q quit") &&
    !frame.includes("Enter submit") && !frame.includes("j/k move · Enter/right expand"));
}

for (const action of ["export", "import"] as const) {
  test(`${action} paths capture q and digits, ignore empty Enter, accept a pasted path and Backspace, and cancel with Esc`, async t => {
    const f = await fixture(t);
    await f.operations.addGitSource("https://example.com/skills.git");
    if (action === "export") {
      f.view.stdin.write("e");
      await waitForFrame(f.view.lastFrame, /https:\/\//);
      f.view.stdin.write("\r");
    } else f.view.stdin.write("i");
    await waitForFrame(f.view.lastFrame, /Profile path: _/);
    f.view.stdin.write("\r");
    f.view.stdin.write("q12345");
    const captured = await waitForFrame(f.view.lastFrame, /Profile path: q12345_/);
    assert.match(captured, /▶ \[5\] Profile/);
    assert.equal(f.exits(), 0);
    f.view.stdin.write("\u007f");
    await waitForFrame(f.view.lastFrame, /Profile path: q1234_/);
    // A multi-character chunk must be preserved, including spaces and view/quit keys.
    f.view.stdin.write("/pasted q12345 path.json");
    await waitForFrame(f.view.lastFrame, /Profile path: q1234\/pasted q12345 path.json_/);
    f.view.stdin.write("\u001b");
    const cancelled = await browse(f.view);
    assert.doesNotMatch(cancelled, /Profile path:|Apply Profile/);
    assert.equal(f.exits(), 0);
  });
}

test("Esc cancels both checklists and a fresh path prompt starts empty", async t => {
  const f = await fixture(t);
  await f.operations.addGitSource("https://example.com/skills.git");
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /https:\/\//);
  f.view.stdin.write("\u001b");
  assert.doesNotMatch(await browse(f.view), /\[x\]|Not transferred because it is always present/);
  const file = path.join(f.home, "cancel.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [], skills: [], apps: [recipe] }));
  await importFile(f.view, file);
  await waitForFrame(f.view.lastFrame, /add: App recipe demo/);
  f.view.stdin.write("\u001b");
  assert.doesNotMatch(await browse(f.view), /add: App recipe demo/);
  assert.deepEqual(await createAppOperations(f.environment.appEnvironment).load(), []);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Profile path: _/);
});

test("unchecking an exported Source recomputes the subset's omitted-Source warning", async t => {
  const f = await fixture(t);
  const source = await f.operations.addGitSource("https://example.com/skills.git");
  await f.operations.addUserGlobalInstallation!({
    source: { kind: "external", url: source.url }, path: "demo",
    version: { policy: "latest" }, hosts: ["pi"],
    installation: { path: ".agents/skills/demo", adopted: false },
  });
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /\[x\] 1 demo/);
  f.view.stdin.write(" ");
  await waitForFrame(f.view.lastFrame, /\[ \] 1 https:\/\/example.com\/skills.git/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Profile path: _/);
  const file = path.join(f.home, "subset.json");
  f.view.stdin.write(file);
  await waitForFrame(f.view.lastFrame, frame => frame.includes(file));
  f.view.stdin.write("\r");
  const preview = await waitForFrame(f.view.lastFrame, /not included in profile/);
  assert.match(preview, /WARNING: Skill demo references Source https:\/\/example.com\/skills.git not included in/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Exported profile to/);
  const exported = parseProfile(JSON.parse(await readFile(file, "utf8")));
  assert.deepEqual(exported.sources, []);
  assert.deepEqual(exported.skills.map(skill => skill.path), ["demo"]);
});

test("import shows same reasons, keeps them unselectable, and reports Sources and successful and failing Skills", async t => {
  const f = await fixture(t);
  const existing = await f.operations.addGitSource("https://example.com/existing.git");
  const skill = { source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi"] };
  const file = path.join(f.home, "results.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [{ url: existing.url, included: false }, { url: "https://example.com/new.git", included: true }],
    skills: [skill, { ...skill, path: "missing-skill" }], apps: [] }));
  await importFile(f.view, file);
  const same = await waitForFrame(f.view.lastFrame, /same: Source/);
  assert.match(same.replaceAll("│", "").replace(/\s+/g, " "), /included: existing true -> incoming false/);
  assert.match(same, /discovery inclusion is not imported/);
  assert.match(same, /not selectable/);
  f.view.stdin.write(" ");
  // Cursor begins on the same Source: space must not mark it.
  const stillSame = await waitForFrame(f.view.lastFrame, /\[ \].*same: Source/);
  assert.doesNotMatch(stillSame, /\[x\].*same: Source/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Apply Profile/);
  f.view.stdin.write("y");
  const results = await waitForFrame(f.view.lastFrame, /failed: Skill missing-skill/);
  assert.match(results, /skipped: Source https:\/\/example.com\/existing.git/);
  assert.match(results, /added: Source https:\/\/example.com\/new.git/);
  assert.match(results, /added: Skill doctor-md-agents/);
  assert.deepEqual((await f.operations.listUserGlobalInstallations!()).map(skill => skill.path), ["doctor-md-agents"]);
  // On the second plan the tracked Skill itself is same and cannot be selected.
  await importFile(f.view, file);
  const repeated = await waitForFrame(f.view.lastFrame, /same: Skill doctor-md-agents/);
  assert.match(repeated, /\[ \].*same: Skill doctor-md-agents.*not selectable/);
});

test("import can deselect every addition and confirm an empty plan without adding recipes", async t => {
  const f = await fixture(t);
  const file = path.join(f.home, "empty-import.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [], skills: [], apps: [recipe] }));
  await importFile(f.view, file);
  await waitForFrame(f.view.lastFrame, /\[x\].*add: App recipe demo/);
  f.view.stdin.write(" ");
  await waitForFrame(f.view.lastFrame, /\[ \].*add: App recipe demo/);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[x\].*add: App recipe demo/);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[ \].*add: App recipe demo/);
  f.view.stdin.write("\r");
  const preview = await waitForFrame(f.view.lastFrame, /Apply Profile/);
  assert.doesNotMatch(preview, /add: App recipe demo/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Nothing selected; nothing written/);
  assert.deepEqual(await createAppOperations(f.environment.appEnvironment).load(), []);
});


test("busy import ignores view, quit, cancel, toggle and action keys until the runner finishes", async t => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted = () => {};
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gitAccess = new GitSourceAccessAdapter({ cachePath: await mkdtemp(path.join(tmpdir(), "profile-busy-cache-")),
    runner: { run: async () => {
      markStarted();
      await gate;
      throw new Error("intentional clone failure");
    } } });
  t.after(() => { release(); return rm(gitAccess.cachePath, { recursive: true, force: true }); });
  const f = await fixture(t, { gitAccess });
  const file = path.join(f.home, "busy.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [{ url: "https://example.com/busy.git", included: true }],
    skills: [{ source: { kind: "external", url: "https://example.com/busy.git" }, path: "demo",
      version: { policy: "latest" }, hosts: ["pi"] }], apps: [recipe] }));
  await importFile(f.view, file);
  await waitForFrame(f.view.lastFrame, /add: App recipe demo/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Apply Profile/);
  f.view.stdin.write("y");
  await started;
  await waitForFrame(f.view.lastFrame, /Loading Profile/);
  f.view.stdin.write("q12345einy ajk");
  f.view.stdin.write("\u001b");
  f.view.stdin.write("\r");
  // Give queued input events time to drain while the external runner remains blocked.
  await new Promise(resolve => setTimeout(resolve, 50));
  const busy = f.view.lastFrame()!;
  assert.match(busy, /Loading Profile/);
  assert.match(busy, /▶ \[5\] Profile/);
  assert.doesNotMatch(busy, /Profile path:/);
  assert.equal(f.exits(), 0);
  release();
  const results = await waitForFrame(f.view.lastFrame, /added: App recipe demo/);
  assert.match(results, /added: Source https:\/\/example.com\/busy.git/);
  assert.match(results, /failed: Skill demo[\s\S]*intentional clone failure/);
  assert.equal((await createAppOperations(f.environment.appEnvironment).load()).length, 1);
  assert.equal(f.exits(), 0);
});

test("export keeps notes visible without letting them change resource selection", async t => {
  const f = await fixture(t);
  for (const name of ["first", "second"]) {
    await writeFile(path.join(f.directory, `${name}.json`), JSON.stringify({ ...recipe, name }));
  }
  f.view.stdin.write("e");
  const initial = await waitForFrame(f.view.lastFrame, /> \[x\] 1 first/);
  assert.match(initial, /Not transferred because it is always present: built-in Source/);
  f.view.stdin.write("j ");
  await waitForFrame(f.view.lastFrame, /> \[ \] 2 second/);
  f.view.stdin.write("jjj");
  const notes = await waitForFrame(f.view.lastFrame, /Not transferred because it is always present/);
  assert.match(notes, /\[ \] 2 second/);
  assert.match(notes, /\[x\] 1 first/);
  f.view.stdin.write("k");
  await waitForFrame(f.view.lastFrame, /> ▾ Export notes/);
  f.view.stdin.write("k ");
  await waitForFrame(f.view.lastFrame, /> \[x\] 2 second/);
});
