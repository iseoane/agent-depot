import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
import { pagedRows, pageToEnd } from "./package-panel.js";
import { fakePackageOperations, installedPackage, piPackage } from "./profile-package-fixture.js";
import { squash, waitForFrame, waitForSettled } from "./wait-for-frame.js";

const recipe = { name: "demo", install: { manual: "Install demo" }, update: { manual: "Update demo" },
  uninstall: { manual: "Remove demo" }, version: { argv: ["demo", "version"], pattern: "(.*)" } };

async function expandExportGroup(view: ReturnType<typeof render>, label: string): Promise<string> {
  const target = label === "Sources" ? "Source choices" : label === "App recipes" ? "Apps" : label;
  let frame = view.lastFrame() ?? "";
  const selectGroup = async (name: string) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const line = frame.split("\n").find(candidate => candidate.includes(">") && candidate.includes(name) && /[▸▾]/u.test(candidate));
      if (line) {
        if (line.includes("▸")) {
          view.stdin.write("\r");
          frame = await waitForFrame(view.lastFrame, next => next !== frame);
        }
        return;
      }
      view.stdin.write("j");
      frame = await waitForFrame(view.lastFrame, next => next !== frame);
    }
    assert.fail(`Group ${name} was not reachable:\n${frame}`);
  };
  if (target !== "Export notes" && target !== "Installed replicas" && !frame.includes("▾ Sources")) await selectGroup("Sources");
  await selectGroup(target);
  return frame;
}

async function fixture(t: TestContext, sourceOptions: SourceOperationsOptions = {}, pickerName = "picker") {
  const home = await mkdtemp(path.join(tmpdir(), "profile-tui-"));
  const directory = path.join(home, "apps");
  const picker = path.join(home, pickerName);
  await mkdir(directory);
  await mkdir(picker);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json"), ...sourceOptions });
  const environment = { homeDirectory: home, startDirectory: picker, appEnvironment: { recipesDirectory: directory,
    runner: async () => { throw new Error("Recipes must not execute"); } } };
  let exits = 0;
  const view = render(<App operations={operations} environment={environment} onExit={() => { exits++; }} />);
  t.after(async () => {
    // A test can end right after switching tabs; the mounted view then still reads state under `home`.
    try {
      await waitForSettled(view.lastFrame);
    } finally {
      view.unmount();
      await rm(home, { recursive: true, force: true });
    }
  });
  await waitForFrame(view.lastFrame, /builtin:agent-depot/);
  view.stdin.write("5");
  await waitForFrame(view.lastFrame, /e export.*i import/);
  return { home, directory, picker, operations, environment, view, exits: () => exits };
}

async function browse(view: ReturnType<typeof render>): Promise<string> {
  return waitForFrame(view.lastFrame, frame => frame.includes("Portable Profile") &&
    !frame.includes("Enter submit") && !frame.includes("Apply Profile") && !frame.includes("Save/Export Profile"));
}

/** Move the picker cursor onto the row that shows `name`; assumes the row appears below the cursor. */
async function selectPickerEntry(view: ReturnType<typeof render>, name: string): Promise<string> {
  let frame = await waitForFrame(view.lastFrame, candidate => candidate.includes(name));
  for (let attempt = 0; attempt < 80; attempt++) {
    if (frame.split("\n").some(line => line.includes("> ") && line.includes(name))) return frame;
    view.stdin.write("j");
    frame = await waitForFrame(view.lastFrame, next => next !== frame);
  }
  assert.fail(`Picker entry ${name} was not reachable:\n${frame}`);
}

/** Open the export folder and name stages and type `fileName`; returns before the file-exists check. */
async function enterExportName(view: ReturnType<typeof render>, fileName: string): Promise<void> {
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /Use this folder/);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Export file name/);
  view.stdin.write("\u0015");
  view.stdin.write(fileName);
  await waitForFrame(view.lastFrame, frame => frame.includes(`Name: ${fileName}_`));
  view.stdin.write("\r");
}

/** Export the current aggregate selection to `fileName` inside the picker's starting directory. */
async function exportNamedFile(view: ReturnType<typeof render>, fileName: string): Promise<string> {
  await enterExportName(view, fileName);
  return waitForFrame(view.lastFrame, /Save\/Export Profile\? \(y\/n\)/);
}

async function importFile(view: ReturnType<typeof render>, file: string): Promise<string> {
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, /Choose import file/);
  await selectPickerEntry(view, path.basename(file));
  view.stdin.write("\r");
  return waitForFrame(view.lastFrame, frame => frame.includes("Import Profile") || frame.includes("Error: "));
}

test("export shows grouped choices and exclusions, confirms a new file and refuses replacement", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  const checklist = await expandExportGroup(f.view, "App recipes");
  assert.match(checklist, /\[x\] 1 App recipe demo \(all platforms\)/);
  const file = path.join(f.picker, "out.json");
  const preview = await exportNamedFile(f.view, "out.json");
  assert.match(preview.replace(/[│\s]/g, ""), new RegExp(`Destination:${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Exported profile to/);
  assert.equal(parseProfile(JSON.parse(await readFile(file, "utf8"))).apps[0]?.name, "demo");
  const original = await readFile(file, "utf8");
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  await enterExportName(f.view, "out.json");
  const refusedFrame = await waitForFrame(f.view.lastFrame, /already[\s│]+exists;[\s│]+choose[\s│]+another[\s│]+name/);
  assert.match(refusedFrame, /out\.json/);
  assert.doesNotMatch(refusedFrame, /Apply Profile|Save\/Export Profile/);
  assert.equal(await readFile(file, "utf8"), original);
});

test("confirming an import subset preserves the selected item after reindexing", async t => {
  const f = await fixture(t);
  const file = path.join(f.picker, "selected.json");
  const laterRecipe = { ...recipe, name: "later" };
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [], skills: [], apps: [recipe, laterRecipe] }));
  const checklist = await importFile(f.view, file);
  assert.match(checklist, /\[x\].*App recipe demo/);
  assert.match(checklist, /\[x\].*App recipe later/);
  f.view.stdin.write(" ");
  const firstDeselected = await waitForFrame(f.view.lastFrame, /\[ \].*App recipe demo/);
  assert.match(firstDeselected, /\[x\].*App recipe later/);
  f.view.stdin.write("j");
  await waitForFrame(f.view.lastFrame, /> \[x\].*App recipe later/);
  f.view.stdin.write("\r");
  const preview = await waitForFrame(f.view.lastFrame, /Apply Profile/);
  assert.doesNotMatch(preview, /add: App recipe demo/);
  assert.match(preview, /add: App recipe later/);
  f.view.stdin.write("y");
  const results = await waitForFrame(f.view.lastFrame, /added: App recipe later/);
  assert.doesNotMatch(results, /added: App recipe demo/);
  const apps = await createAppOperations({ homeDirectory: f.home, ...f.environment.appEnvironment }).load();
  assert.deepEqual(apps.map(entry => entry.recipe?.name), ["later"]);
});

test("import warns on newer producers, skips conflicts and adds recipes unapproved without commands", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify({ ...recipe, install: { manual: "Keep existing install" } }));
  const file = path.join(f.picker, "in.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "99.0.0",
    sources: [], skills: [], apps: [recipe, { ...recipe, name: "second" }] }));
  const checklist = await importFile(f.view, file);
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
  test(`import reports ${label} in the browser without writing or losing navigation`, async t => {
    const f = await fixture(t);
    const file = path.join(f.picker, "invalid.json");
    await writeFile(file, content);
    const result = await importFile(f.view, file);
    assert.match(result, /Error: /);
    assert.doesNotMatch(result, /Apply Profile|add: /);
    assert.match(result, reason);
    assert.match(result, /Choose import file/);
    assert.deepEqual(await createAppOperations(f.environment.appEnvironment).load(), []);
    assert.equal((await f.operations.listSources()).length, 1);
    f.view.stdin.write("\u001b");
    await browse(f.view);
    f.view.stdin.write("1");
    await waitForFrame(f.view.lastFrame, /▶ \[1\] Sources/);
  });
}

test("a directory read error stays recoverable and long export lists are windowed", async t => {
  const f = await fixture(t);
  const errorView = render(<ProfileView operations={f.operations} listHeight={8}
    environment={{ ...f.environment, startDirectory: path.join(f.home, "missing") }} />);
  t.after(() => errorView.unmount());
  errorView.stdin.write("i");
  const error = await waitForFrame(errorView.lastFrame, /Error:.*ENOENT/);
  assert.match(error, /Choose import file/);
  errorView.stdin.write("\u001b");
  await waitForFrame(errorView.lastFrame, /e export · i import/);

  for (let index = 0; index < 20; index++) await writeFile(path.join(f.directory, `${index}.json`), JSON.stringify({ ...recipe, name: `demo-${index}` }));
  const view = render(<ProfileView operations={f.operations} environment={f.environment} listHeight={3} />);
  t.after(() => view.unmount());
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /▸ Sources/);
  await expandExportGroup(view, "Apps");
  let frame = view.lastFrame() ?? "";
  for (let attempt = 0; attempt < 40 && !frame.split("\n").some(line => line.includes("> ▸ Export notes")); attempt++) {
    view.stdin.write("j");
    frame = await waitForFrame(view.lastFrame, next => next !== frame);
  }
  view.stdin.write("\r");
  frame = await waitForFrame(view.lastFrame, /▾ Export notes/);
  assert.ok(frame.split("\n").length < 12);
  view.stdin.write("j".repeat(20));
  const scrolled = await waitForFrame(view.lastFrame, frame => frame.includes("of 25") && frame.includes("Export notes"));
  assert.match(scrolled, /of 25/);
});

test("import previews recorded method argv and unregistered Sources; declining returns to the checklist", async t => {
  const f = await fixture(t);
  const file = path.join(f.picker, "methods.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "99.0.0",
    sources: [], apps: [], skills: [{ source: { kind: "external", url: "https://github.com/example/skills.git" },
      path: "demo", hosts: ["pi"], version: { policy: "latest" }, methods: { install: { kind: "command", argv: ["demo", "install"] } } }] }));
  await importFile(f.view, file);
  f.view.stdin.write("\r");
  const preview = await waitForFrame(f.view.lastFrame, /Apply Profile/);
  assert.match(preview, /argv=\["demo","install"\]/);
  assert.match(preview, /will be fetched but not registered/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("Import Profile") && !frame.includes("Apply Profile"));
  f.view.stdin.write("\u001b");
  await browse(f.view);
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
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  let frame = await expandExportGroup(f.view, "Sources");
  assert.match(frame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  frame = await expandExportGroup(f.view, "Skills");
  assert.match(frame, /\[x\] 1 Skill demo from https:\/\/example.com\/skills.git/);
  frame = await expandExportGroup(f.view, "Apps");
  assert.match(frame, /\[x\] 1 App recipe demo/);
  frame = await expandExportGroup(f.view, "Export notes");
  assert.match(frame, /Not transferred because it is always present: built-in Source/);
  assert.doesNotMatch(frame, /\[ \].*Not transferred/);
});

test("export panel stays inside a resized terminal with wrapped choices and the picker and name stages", async t => {
  // A long export folder wraps the name stage's Folder and Destination onto several rows on any machine.
  const f = await fixture(t, {}, "long-export-folder-name-for-the-wrapped-name-stage");
  const url = `https://example.com/${"long-path-segment/".repeat(8)}skills.git`;
  await f.operations.addGitSource(url);
  const unmanaged = path.join(f.home, ".agents", "skills", `${"very-long-unmanaged-name-".repeat(3)}skill`);
  await mkdir(unmanaged, { recursive: true });
  await writeFile(path.join(unmanaged, "SKILL.md"), "---\nname: unmanaged\ndescription: fixture\n---\n");
  const view = f.view;
  const rows = 17;
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: rows });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 40 });
  view.stdout.emit("resize");
  view.stdin.write("e");
  let frame = await waitForFrame(view.lastFrame, /Export Profile/);
  assert.ok(frame.split("\n").length <= rows, frame);
  frame = await expandExportGroup(view, "Export notes");
  view.stdin.write("j".repeat(2));
  frame = await waitForFrame(view.lastFrame, candidate => candidate.split("\n").some(line =>
    line.includes(">") && line.includes("very-long")));
  assert.ok(frame.split("\n").length <= rows, frame);
  assert.ok(frame.replace(/[│\s]/g, "").includes("very-long-unmanaged-name-"), frame);
  view.stdin.write("\r");
  const detail = await waitForFrame(view.lastFrame, /Export note/);
  assert.ok(detail.split("\n").length <= rows, detail);
  assert.match(detail, /Excluded unmanaged Skill/);
  view.stdin.write("j".repeat(30));
  const detailTail = await waitForFrame(view.lastFrame, /not tracked/);
  assert.ok(detailTail.split("\n").length <= rows, detailTail);
  view.stdin.write("\u001b");
  frame = await waitForFrame(view.lastFrame, frame => frame.includes("Export Profile") &&
    frame.split("\n").some(line => line.includes("> ") && line.includes("Excluded unmanaged Skill very-long")));
  assert.match(frame, />\s+Excluded unmanaged Skill very-long/);

  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, /e export · i import/);
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /Export Profile/);
  await expandExportGroup(view, "Sources");
  view.stdin.write("j");
  view.stdin.write("e");
  const folder = await waitForFrame(view.lastFrame, /Choose export folder/);
  assert.ok(folder.split("\n").length <= rows, folder);
  assert.match(folder, /Esc/);
  await waitForFrame(view.lastFrame, /Use this folder/);
  view.stdin.write("\r");
  const name = await waitForFrame(view.lastFrame, /Export file name/);
  assert.ok(name.split("\n").length <= rows, name);
  assert.match(name, /Ctrl\+U clear/);
  assert.match(name, /Folder: .*…/s, "a path the stage cannot show whole is marked as cut");
  assert.match(name, /Destination: .*…/s, "the destination is marked as cut too");
  view.stdin.write("\u0015");
  view.stdin.write("review.json");
  await waitForFrame(view.lastFrame, /review\.json_/);
  view.stdin.write("\r");
  const confirmation = await waitForFrame(view.lastFrame, /Save\/Export Profile\? \(y\/n\)/);
  assert.ok(confirmation.split("\n").length <= rows, confirmation);
  const confirmationPages = await pageToEnd(view.lastFrame, view.stdin, rows);
  assert.ok(confirmationPages.length > 1, "the confirmation needs paging at this height");
  assert.ok(squash(pagedRows(confirmationPages).join("")).includes(squash(`Destination: ${path.join(f.picker, "review.json")}`)),
    "paging the confirmation reveals the whole destination");
  assert.match(confirmation, /arrows\/PgUp\/PgDn page/);
  assert.doesNotMatch(confirmation, /Portable Profile|▸ Sources/);
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
  await waitForFrame(view.lastFrame, /▸ Sources/);
  await expandExportGroup(view, "Skills");
  const step = async (key: string) => {
    const before = view.lastFrame();
    view.stdin.write(key);
    return waitForFrame(view.lastFrame, frame => frame !== before);
  };
  let frame = view.lastFrame() ?? "";
  for (let index = 0; index < 12 && !/> \[x\] 4 Skill skill-4/.test(frame); index++) frame = await step("j");
  assert.match(frame, /> \[x\] 4 Skill skill-4/);
  assert.equal([...frame.matchAll(/▾ Skills \(6\)/g)].length, 1, frame);
  frame = await step(" ");
  assert.match(frame, /> \[ \] 4 Skill skill-4/);
  for (let index = 0; index < 12 && !/>.*▾ Skills/.test(frame); index++) frame = await step("k");
  assert.match(frame, />.*▾ Skills/);
  const collapsed = await step("\r");
  assert.match(collapsed, /▸ Skills \(6\)/);
  assert.doesNotMatch(collapsed, /skill-4/);
  view.stdin.write("\r");
  let expanded = await waitForFrame(view.lastFrame, /▾ Skills \(6\)/);
  for (let index = 0; index < 8 && !/\[ \] 4 Skill skill-4/.test(expanded); index++) expanded = await step("j");
  assert.match(expanded, /\[ \] 4 Skill skill-4/);
  for (let index = 0; index < 8 && !/\[x\] 6 Skill skill-6/.test(expanded); index++) expanded = await step("j");
  assert.match(expanded, /\[x\] 6 Skill skill-6/);
});

test("Packages appear in the export checklist and import previews the recorded selection", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "profile-tui-packages-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const picker = path.join(home, "picker");
  await mkdir(picker);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const { operations: exporter } = fakePackageOperations({ recorded: [installedPackage] });
  const view = render(<ProfileView operations={operations} environment={{ homeDirectory: home, startDirectory: picker, packages: exporter }} />);
  t.after(() => view.unmount());
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /▸ Sources/);
  await expandExportGroup(view, "Packages");
  view.stdin.write("j");
  const checklist = await waitForFrame(view.lastFrame, /Package pi plugins\/demo from https:\/\/example\.test\/demo\.git/);
  assert.match(checklist, /\[x\] 1 Package pi plugins\/demo from https:\/\/example\.test\/demo\.git \(latest; saved selection\)/);
  await exportNamedFile(view, "out.json");
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Exported profile to/);
  const exported = JSON.parse(await readFile(path.join(picker, "out.json"), "utf8"));
  assert.deepEqual(parseProfile(exported).packages, [piPackage]);

  const input = path.join(picker, "in.json");
  await writeFile(input, JSON.stringify({ ...exported, sources: [], skills: [], apps: [] }));
  const { operations: importer, evidence } = fakePackageOperations({});
  const importing = render(<ProfileView operations={operations} environment={{ homeDirectory: home, startDirectory: picker, packages: importer }} />);
  t.after(() => importing.unmount());
  await importFile(importing, input);
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

test("v2 replica intent is preview-only and follows the selected import resources", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "profile-tui-replica-import-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const picker = path.join(home, "picker");
  await mkdir(picker);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const recipesDirectory = path.join(home, "apps");
  await mkdir(recipesDirectory);
  const packageSelection = { ...piPackage, root: "plugins/pstack",
    source: { kind: "external" as const, url: "https://github.com/michael-denyer/pstack-claude" } };
  const recipeForImport = { ...recipe, name: "gentle-shell", platform: "linux" as const,
    version: { argv: ["gentle-shell", "--version"], pattern: "(.*)" } };
  const file = path.join(picker, "replicas-v2.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v2", agentDepotVersion: "0.5.2",
    sources: [], skills: [], apps: [recipeForImport], packages: [packageSelection], replicas: [
      { kind: "app", name: recipeForImport.name, platform: recipeForImport.platform },
      { kind: "package", selection: packageSelection },
    ] }));
  const { operations: packages, evidence } = fakePackageOperations({});
  const view = render(<ProfileView operations={operations} environment={{ homeDirectory: home, startDirectory: picker,
    appEnvironment: { recipesDirectory, runner: async () => { throw new Error("recipe commands must not run"); } }, packages }} />);
  t.after(() => view.unmount());

  await importFile(view, file);
  view.stdin.write("\r");
  let preview = await waitForFrame(view.lastFrame, /Apply Profile/);
  assert.match(preview, /Origin replica intent: Installed App gentle-shell \(linux\)/);
  const normalizedPreview = preview.replace(/[│\s]/g, "");
  assert.ok(normalizedPreview.includes(
    "Originreplicaintent:InstalledPackagepiplugins/pstackfromhttps://github.com/michael-denyer/pstack-claude"));
  assert.ok(normalizedPreview.includes("doesnotapproveorinstallit"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("Import Profile") && !frame.includes("Apply Profile"));
  view.stdin.write("\u001b");
  await browse(view);
  assert.deepEqual(evidence.approvals, []);
  assert.deepEqual(evidence.executions, []);
  assert.deepEqual(await createAppOperations({ recipesDirectory }).load(), []);

  await importFile(view, file);
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, /add: Package pi plugins\/pstack/);
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, /\[ \].*add: Package pi plugins\/pstack/);
  view.stdin.write("\r");
  preview = await waitForFrame(view.lastFrame, /Apply Profile/);
  assert.match(preview, /Origin replica intent: Installed App gentle-shell \(linux\)/);
  assert.ok(!preview.replace(/[│\s]/g, "").includes("Originreplicaintent:InstalledPackagepiplugins/pstack"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("Import Profile") && !frame.includes("Apply Profile"));
  assert.deepEqual(evidence.approvals, []);
  assert.deepEqual(evidence.executions, []);
  assert.deepEqual(await createAppOperations({ recipesDirectory }).load(), []);
});

test("space and all toggle export choices; e with an empty selection stops before the picker", async t => {
  const f = await fixture(t);
  await f.operations.addGitSource("https://example.com/skills.git");
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  await expandExportGroup(f.view, "Sources");
  f.view.stdin.write("j");
  await waitForFrame(f.view.lastFrame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  f.view.stdin.write(" ");
  const unselected = await waitForFrame(f.view.lastFrame, /\[ \] 1 https:\/\/example.com\/skills.git/);
  assert.match(unselected, /Sources/);
  f.view.stdin.write("a");
  const cleared = await waitForFrame(f.view.lastFrame, /\[ \] 1 https:\/\/example.com\/skills.git/);
  assert.ok(cleared);
  f.view.stdin.write("a");
  const all = await waitForFrame(f.view.lastFrame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  assert.ok(all);
  await expandExportGroup(f.view, "Apps");
  f.view.stdin.write("j");
  const appSelected = await waitForFrame(f.view.lastFrame, /\[x\] 1 App recipe demo/);
  assert.ok(appSelected);
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /\[ \] 1 App recipe demo/);
  f.view.stdin.write("e");
  const empty = await waitForFrame(f.view.lastFrame, /Nothing selected; nothing written/);
  assert.doesNotMatch(empty, /Choose export folder|Export file name|Apply Profile|Save\/Export Profile/);
});

test("the export footer labels keys, names the Esc target, and drops Enter where it does nothing", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  const frame = await waitForFrame(f.view.lastFrame, /Export Profile/);
  assert.match(frame.replace(/[│\n]/g, ""), /e export · Esc back to\s*menu/);
  assert.match(frame, /1 selected/);
  assert.match(frame, /Enter open/);
  assert.doesNotMatch(frame, /preview shows full text/);
  await expandExportGroup(f.view, "App recipes");
  f.view.stdin.write("j");
  const resource = await waitForFrame(f.view.lastFrame, /> \[x\] 1 App recipe demo/);
  assert.doesNotMatch(resource, /Enter open|Enter note|Enter group/);
  assert.match(resource, /space toggle · a all · e export/);
});

test("Enter on a resource row never starts export; e on any row exports the aggregate", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Export Profile/);
  await expandExportGroup(f.view, "App recipes");
  f.view.stdin.write("j");
  await waitForFrame(f.view.lastFrame, /App recipe demo/);
  f.view.stdin.write("\r");
  const unchanged = await waitForFrame(f.view.lastFrame, /Export Profile/);
  assert.doesNotMatch(unchanged, /Choose export folder|Export file name|Apply Profile|Save\/Export Profile/);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Choose export folder/);
});

test("e exports the aggregate selection from a collapsed group row", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  const list = await waitForFrame(f.view.lastFrame, /▸ Sources/);
  assert.doesNotMatch(list, /App recipe demo/);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Choose export folder/);
});

test("the picker keeps view and quit keys, moves, and the name editor captures text, clears and preserves", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Export Profile/);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Choose export folder/);
  await waitForFrame(f.view.lastFrame, /Use this folder/);
  f.view.stdin.write("q12345");
  const captured = await waitForFrame(f.view.lastFrame, /Choose export folder/);
  assert.match(captured, /▶ \[5\] Profile/);
  assert.equal(f.exits(), 0);
  f.view.stdin.write("j");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("> .. (parent folder)"));
  f.view.stdin.write("\u001b");
  await waitForFrame(f.view.lastFrame, /Export Profile/);
  assert.match(f.view.lastFrame()!, /1 selected/);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /Choose export folder/);
  await waitForFrame(f.view.lastFrame, /Use this folder/);
  f.view.stdin.write("\r");
  const defaulted = await waitForFrame(f.view.lastFrame, /Export file name/);
  assert.match(defaulted, /Name: agent-depot-profile\.json_/);
  f.view.stdin.write("\u0015");
  await waitForFrame(f.view.lastFrame, /Name: _/);
  f.view.stdin.write("q12345");
  await waitForFrame(f.view.lastFrame, /Name: q12345_/);
  assert.equal(f.exits(), 0);
  f.view.stdin.write("\u001b");
  await waitForFrame(f.view.lastFrame, /Choose export folder/);
  await waitForFrame(f.view.lastFrame, /Use this folder/);
  f.view.stdin.write("\r");
  const preserved = await waitForFrame(f.view.lastFrame, /Name: q12345_/);
  assert.match(preserved, /q12345/);
  f.view.stdin.write("\u0015");
  await waitForFrame(f.view.lastFrame, /Name: _/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Enter a file name/);
});

test("Esc cancels the export checklist and the import browser, and a fresh browse clears the notice", async t => {
  const f = await fixture(t);
  await f.operations.addGitSource("https://example.com/skills.git");
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  f.view.stdin.write("\u001b");
  assert.doesNotMatch(await browse(f.view), /\[x\]|Not transferred because it is always present/);
  f.view.stdin.write("i");
  await waitForFrame(f.view.lastFrame, /Choose import file/);
  f.view.stdin.write("\u001b");
  await browse(f.view);
  const bad = path.join(f.picker, "bad.json");
  await writeFile(bad, "{");
  await importFile(f.view, bad);
  await waitForFrame(f.view.lastFrame, /Error: /);
  f.view.stdin.write("\u001b");
  await browse(f.view);
  f.view.stdin.write("i");
  const fresh = await waitForFrame(f.view.lastFrame, /Choose import file/);
  assert.doesNotMatch(fresh, /Error: /);
});

test("export refuses an existing file and a dangling symlink at the name stage", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  const existing = path.join(f.picker, "taken.json");
  await writeFile(existing, "keep");
  const link = path.join(f.picker, "link.json");
  await symlink(path.join(f.picker, "nowhere.json"), link);
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  await enterExportName(f.view, "taken.json");
  await waitForFrame(f.view.lastFrame, /already[\s│]+exists;[\s│]+choose[\s│]+another[\s│]+name/);
  assert.equal(await readFile(existing, "utf8"), "keep");
  f.view.stdin.write("\u0015");
  f.view.stdin.write("link.json");
  await waitForFrame(f.view.lastFrame, /Name: link\.json_/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /already[\s│]+exists;[\s│]+choose[\s│]+another[\s│]+name/);
  assert.equal(await readlink(link), path.join(f.picker, "nowhere.json"));
  assert.ok((await lstat(link)).isSymbolicLink());
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
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  await expandExportGroup(f.view, "Sources");
  f.view.stdin.write("j");
  await waitForFrame(f.view.lastFrame, /\[x\] 1 https:\/\/example.com\/skills.git/);
  f.view.stdin.write(" ");
  await waitForFrame(f.view.lastFrame, /\[ \] 1 https:\/\/example.com\/skills.git/);
  await exportNamedFile(f.view, "subset.json");
  const preview = await waitForFrame(f.view.lastFrame, /not included in profile/);
  assert.match(preview, /WARNING: Skill demo references Source https:\/\/example.com\/skills.git not included in/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Exported profile to/);
  const exported = parseProfile(JSON.parse(await readFile(path.join(f.picker, "subset.json"), "utf8")));
  assert.deepEqual(exported.sources, []);
  assert.deepEqual(exported.skills.map(skill => skill.path), ["demo"]);
});

test("import shows same reasons, keeps them unselectable, and reports Sources and successful and failing Skills", async t => {
  const f = await fixture(t);
  const existing = await f.operations.addGitSource("https://example.com/existing.git");
  const skill = { source: { kind: "builtin", id: "builtin:agent-depot" }, path: "doctor-md-agents",
    version: { policy: "latest" }, hosts: ["pi"] };
  const file = path.join(f.picker, "results.json");
  await writeFile(file, JSON.stringify({ format: "agent-depot-profile/v1", agentDepotVersion: "0.3.0",
    sources: [{ url: existing.url, included: false }, { url: "https://example.com/new.git", included: true }],
    skills: [skill, { ...skill, path: "missing-skill" }], apps: [] }));
  const same = await importFile(f.view, file);
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
  await importFile(f.view, file);
  const repeated = await waitForFrame(f.view.lastFrame, /same: Skill doctor-md-agents/);
  assert.match(repeated, /\[ \].*same: Skill doctor-md-agents.*not selectable/);
});

test("import can deselect every addition and confirm an empty plan without adding recipes", async t => {
  const f = await fixture(t);
  const file = path.join(f.picker, "empty-import.json");
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
  const file = path.join(f.picker, "busy.json");
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
  await waitForFrame(f.view.lastFrame, /Applying import…/);
  f.view.stdin.write("q12345einy ajk");
  f.view.stdin.write("\u001b");
  f.view.stdin.write("\r");
  await new Promise(resolve => setTimeout(resolve, 50));
  const busy = f.view.lastFrame()!;
  assert.match(busy, /Applying import…/);
  assert.match(busy, /▶ \[5\] Profile/);
  assert.doesNotMatch(busy, /Choose import file|Export file name/);
  assert.equal(f.exits(), 0);
  release();
  const results = await waitForFrame(f.view.lastFrame, /added: App recipe demo/);
  assert.match(results, /added: Source https:\/\/example.com\/busy.git/);
  assert.match(results, /failed: Skill demo[\s\S]*intentional clone failure/);
  assert.equal((await createAppOperations(f.environment.appEnvironment).load()).length, 1);
  assert.equal(f.exits(), 0);
});

test("export keeps notes separate from resource selection", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "demo.json"), JSON.stringify(recipe));
  f.view.stdin.write("e");
  await waitForFrame(f.view.lastFrame, /▸ Sources/);
  await expandExportGroup(f.view, "App recipes");
  const appRow = await waitForFrame(f.view.lastFrame, /\[x\] 1 App recipe demo/);
  assert.doesNotMatch(appRow, /Not transferred/);
  await expandExportGroup(f.view, "Export notes");
  const note = await waitForFrame(f.view.lastFrame, /Export notes/);
  assert.match(note, /Selected Skills are exported with their version policy/);
  assert.match(note, /Not transferred because it is always present: built-in Source/);
  assert.match(note, /\[x\] 1 App recipe demo/);
});

async function nameStageFixture(t: TestContext, existsCheck: (target: string) => Promise<boolean>) {
  const home = await mkdtemp(path.join(tmpdir(), "profile-name-stage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const picker = path.join(home, "picker");
  const directory = path.join(home, "apps");
  await mkdir(picker);
  await mkdir(directory);
  await writeFile(path.join(directory, "demo.json"), JSON.stringify(recipe));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const view = render(<ProfileView operations={operations} existsCheck={existsCheck}
    environment={{ homeDirectory: home, startDirectory: picker,
      appEnvironment: { recipesDirectory: directory, runner: async () => { throw new Error("Recipes must not execute"); } } }} />);
  t.after(() => view.unmount());
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /▸ Sources/);
  view.stdin.write("e");
  await waitForFrame(view.lastFrame, /Use this folder/);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /Export file name/);
  view.stdin.write("\u0015");
  return { view, picker };
}

test("a slow existence check for an older name never confirms after the name is edited", async t => {
  let release = () => {};
  const firstCheck = new Promise<boolean>(resolve => { release = () => resolve(false); });
  let calls = 0;
  const { view } = await nameStageFixture(t, async () => {
    calls += 1;
    return calls === 1 ? firstCheck : Promise.resolve(false);
  });
  view.stdin.write("first.json");
  await waitForFrame(view.lastFrame, /first\.json_/);
  view.stdin.write("\r");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(view.lastFrame()!.includes("Export file name"));
  assert.doesNotMatch(view.lastFrame()!, /Save\/Export Profile/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /first\.json2_/);
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(view.lastFrame()!, /Export file name/);
  assert.doesNotMatch(view.lastFrame()!, /Save\/Export Profile|already exists/);
  view.stdin.write("\r");
  const confirmation = await waitForFrame(view.lastFrame, /Save\/Export Profile\? \(y\/n\)/);
  assert.match(confirmation, /Destination: /);
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("Export file name") && !frame.includes("Save/Export Profile"));
});

test("a pending destination check shows an inline indicator and keys still edit the name", async t => {
  let release = () => {};
  const check = new Promise<boolean>(resolve => { release = () => resolve(false); });
  const { view } = await nameStageFixture(t, () => check);
  view.stdin.write("out.json");
  await waitForFrame(view.lastFrame, /out\.json_/);
  view.stdin.write("\r");
  const pending = await waitForFrame(view.lastFrame, /Checking name…/);
  assert.match(pending, /Export file name/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /out\.json2_/);
  release();
  await waitForFrame(view.lastFrame, frame => !frame.includes("Checking name…"));
});

test("a failing destination check is reported inline in the name stage", async t => {
  const { view } = await nameStageFixture(t, async () => {
    throw Object.assign(new Error("permission denied, open '/root/out.json'"), { code: "EACCES" });
  });
  view.stdin.write("out.json");
  await waitForFrame(view.lastFrame, /out\.json_/);
  view.stdin.write("\r");
  const failure = await waitForFrame(view.lastFrame, /Error: permission denied/);
  assert.match(failure, /Export file name/);
  assert.doesNotMatch(failure, /Save\/Export Profile/);
  view.stdin.write("x");
  await waitForFrame(view.lastFrame, frame => frame.includes("out.jsonx_") && !frame.includes("Error:"));
});

test("the Enter that chooses the export folder is not also submitted to the name stage", async t => {
  const { view, picker } = await nameStageFixture(t, async () => Promise.resolve(false));
  assert.match(view.lastFrame()!, /Name: _/);
  view.stdin.write("\u0015");
  await waitForFrame(view.lastFrame, /Name: _/);
  view.stdin.write("profile");
  const appended = await waitForFrame(view.lastFrame, /Name: profile_/);
  assert.match(appended, /A name without an extension is saved as profile\.json\./);
  assert.ok(squash(appended).includes(squash(`Destination: ${path.join(picker, "profile.json")}`)), appended); // a long path wraps
  await new Promise(resolve => setTimeout(resolve, 50));
  const settled = view.lastFrame()!;
  assert.match(settled, /Export file name/);
  assert.doesNotMatch(settled, /Save\/Export Profile|Apply Profile/);
});
