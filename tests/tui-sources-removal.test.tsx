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
import { waitForFrame, waitForSettled } from "./wait-for-frame.js";
import { deferCleanup } from "./test-cleanup.js";
import { confirmAtEnd, panelRows, PREVIEW_SIZES, resizeTerminal, readPreview } from "./preview-footer.js";

async function fixture(t: TestContext, installed = false, failUninstall = false, manual = false) {
  const home = await mkdtemp(path.join(tmpdir(), "sources-removal-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  const file = path.join(directory, "demo.json");
  await writeFile(file, JSON.stringify({ name: "demo", install: { argv: ["demo", "install"] }, update: { manual: "update demo" },
    uninstall: manual ? { manual: "Uninstall demo in your terminal" } : { argv: ["demo", "remove"] },
    version: { argv: ["demo", "version"], pattern: "(1\\.2\\.3)" } }));
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory: directory, platform: "linux", isWsl: false,
    resolveExecutable: async name => `/bin/${name}`, runner: async (command, args) => {
      commands.push(args[0]);
      if (args[0] === "remove") {
        if (failUninstall) return { code: 1, signal: null, stdout: Buffer.from("uninstall failed"), stderr: "", outputTooLarge: false };
        installed = false;
      }
      const present = installed && command === "/bin/demo";
      return { code: args[0] === "version" && !present ? 1 : 0, signal: null, stdout: Buffer.from(present ? "1.2.3" : ""), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  const [entry] = await apps.load();
  await apps.approve(entry);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const environment = { homeDirectory: home, projectRoot: home, appEnvironment };
  const view = render(<SourcesView operations={operations} environment={environment} />);
  deferCleanup(t, async () => { view.unmount(); await rm(home, { recursive: true, force: true }); });
  await waitForFrame(view.lastFrame, /approved/);
  return { view, home, file, commands, apps, operations, environment, markUninstalled: () => { installed = false; } };
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
  await readPreview(f.view, /Remove recipe for demo\? y\/n/);
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
  const preview = await readPreview(f.view, /Uninstall demo\? y\/n/);
  assert.match(preview, /\$ demo remove/u);
  assert.ok(!f.commands.includes("remove"));
  f.view.stdin.write("y");
  await readPreview(f.view, /Remove recipe for demo\? y\/n/);
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
  await readPreview(f.view, /Uninstall demo\? y\/n/);
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
  await readPreview(f.view, /Remove recipe for demo\? y\/n/);
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
  deferCleanup(t, () => view.unmount());
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
  await waitForFrame(f.view.lastFrame, /needs\s+approval/); // a long path wraps the status
  f.view.stdin.write("d");
  // Long temporary paths (Windows) push the version step off the first page, so read the preview row by row.
  let frame = await waitForFrame(f.view.lastFrame, /read [█░]* ?\d+%/u);
  let reviewed = frame;
  for (let step = 0; step < 200 && !/read ✓/u.test(frame); step += 1) {
    const position = /Review (\d+) of/u.exec(frame)?.[1];
    f.view.stdin.write("j");
    frame = await waitForFrame(f.view.lastFrame, candidate => /Review (\d+) of/u.exec(candidate)?.[1] !== position);
    reviewed += `\n${frame}`;
  }
  assert.match(reviewed, /[├└] version[\s\S]*\$ demo version/u);
  assert.deepEqual(f.commands, []);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, text => !text.includes("Approve demo?"));
  assert.ok(await readFile(f.file));
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /read [█░]* ?\d+%/u);
  await readPreview(f.view, /Approve demo\? y\/n/, true);
  assert.deepEqual(f.commands, []);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Remove recipe for demo\? y\/n/);
  assert.deepEqual(f.commands, ["version"]);
  assert.ok(await readFile(f.file));
});

for (const size of PREVIEW_SIZES) {
  test(`App uninstall before recipe removal accepts y exactly when its footer reads to the end at ${size.columns}x${size.rows}`, async t => {
    const f = await fixture(t, true);
    resizeTerminal(f.view, size);
    f.view.stdin.write("d");
    await waitForFrame(f.view.lastFrame, /Uninstall it before/);
    f.view.stdin.write("y");
    await confirmAtEnd(f.view, size.rows, /\[y\] Uninstall demo/, () => f.commands.includes("remove"));
    await confirmAtEnd(f.view, size.rows, /\[y\] Remove the demo recipe/, () => /Removed App recipe:/.test(f.view.lastFrame() ?? ""));
  });
}

for (const size of PREVIEW_SIZES) {
  test(`manual App uninstall names its check in the shared footer at ${size.columns}x${size.rows}`, async t => {
    const f = await fixture(t, true, false, true);
    resizeTerminal(f.view, size);
    f.view.stdin.write("d");
    await waitForFrame(f.view.lastFrame, /Uninstall it before/);
    f.view.stdin.write("y");
    f.markUninstalled();
    await confirmAtEnd(f.view, size.rows, /\[y\] Check the uninstall now/, () => /Recipe removal/.test(f.view.lastFrame() ?? ""));
    await confirmAtEnd(f.view, size.rows, /\[y\] Remove the demo recipe/, () => /Removed App recipe:/.test(f.view.lastFrame() ?? ""));
  });
}

test("the App uninstall before recipe removal shows its header and one block with the command and where it runs", async t => {
  const f = await fixture(t, true);
  resizeTerminal(f.view, { columns: 220, rows: 80 });
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Uninstall it before/);
  f.view.stdin.write("y");
  const rows = panelRows(await waitForFrame(f.view.lastFrame, /read ✓/u));
  const start = rows.findIndex(row => row.startsWith(" App demo uninstall"));
  assert.ok(start >= 0, rows.join("\n"));
  assert.deepEqual(rows.slice(start, start + 5), [
    " App demo uninstall",
    " ",
    " └ uninstall",
    "   $ demo remove",
    `   /bin/demo · in ${f.home} · on linux`,
  ].map(row => row.trimEnd()));
  assert.deepEqual(f.commands, ["version"]);
});

test("a manual App uninstall before recipe removal shows its instruction in the same block", async t => {
  const f = await fixture(t, true, false, true);
  resizeTerminal(f.view, { columns: 220, rows: 80 });
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Uninstall it before/);
  f.view.stdin.write("y");
  const rows = panelRows(await waitForFrame(f.view.lastFrame, /read ✓/u));
  const start = rows.findIndex(row => row.startsWith(" App demo uninstall"));
  assert.ok(start >= 0, rows.join("\n"));
  assert.deepEqual(rows.slice(start, start + 4), [
    " App demo uninstall",
    " ",
    " └ uninstall",
    "   Manual: Uninstall demo in your terminal",
  ].map(row => row.trimEnd()));
  assert.equal(rows[start + 4]?.trimEnd(), `   in ${f.home} · on linux`);
});

for (const size of PREVIEW_SIZES) {
  test(`recipe removal accepts y exactly when its footer reads to the end at ${size.columns}x${size.rows}`, async t => {
    const f = await fixture(t);
    resizeTerminal(f.view, size);
    f.view.stdin.write("d");
    await confirmAtEnd(f.view, size.rows, /\[y\] Remove the demo recipe/, () => /Removed App recipe:/.test(f.view.lastFrame() ?? ""));
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
  });
}

for (const [label, cancelKey] of [["n", "n"], ["Esc", "\u001B"]] as const) {
  test(`recipe removal ignores y mid-read and ${label} cancels it`, async t => {
    const f = await fixture(t);
    resizeTerminal(f.view, { columns: 40, rows: 12 });
    f.view.stdin.write("d");
    const reading = await waitForFrame(f.view.lastFrame, /read [█░]* ?\d+%/u);
    f.view.stdin.write("y");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(f.view.lastFrame() ?? "", /read [█░]* ?\d+%/u, reading);
    assert.ok(await readFile(f.file));
    f.view.stdin.write(cancelKey);
    await waitForFrame(f.view.lastFrame, text => !/Recipe removal|read [█░]* ?\d+%/u.test(text));
    assert.ok(await readFile(f.file));
  });
}

test("the recipe removal preview stands alone: no earlier notice sits above it in the whole App", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, "apps", "other.json"), JSON.stringify({ name: "other", install: { argv: ["other", "install"] }, update: { manual: "update other" },
    uninstall: { argv: ["other", "remove"] }, version: { argv: ["other", "version"], pattern: "(1\\.2\\.3)" } }));
  for (const entry of await f.apps.load()) await f.apps.approve(entry);
  f.view.unmount();
  const view = render(<App operations={f.operations} environment={f.environment} />);
  deferCleanup(t, () => view.unmount());
  resizeTerminal(view, { columns: 80, rows: 24 });
  await waitForFrame(view.lastFrame, text => /demo/.test(text) && /other/.test(text));
  view.stdin.write("d");
  await readPreview(view, /Remove recipe for \w+\? y\/n/u);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Removed App recipe/);
  await waitForSettled(view.lastFrame);
  view.stdin.write("d");
  const frame = await waitForFrame(view.lastFrame, /Delete recipe:/u);
  assert.doesNotMatch(frame, /Removed App recipe/);
  assert.match(frame, /read [█░]* ?\d+%|read ✓/u);
  assert.ok(frame.split("\n").length <= 24, frame);
});

/** Removes the uninstalled `alpha` recipe so its notice is on screen, then opens the removal of `demo`. */
async function removalAfterNotice(t: TestContext, kind: "approve" | "uninstall-confirm" | "uninstall-manual") {
  const f = await fixture(t, kind !== "approve", false, kind === "uninstall-manual");
  const recipe = { name: "alpha", install: { argv: ["alpha", "install"] }, update: { manual: "update alpha" },
    uninstall: { argv: ["alpha", "remove"] }, version: { argv: ["alpha", "version"], pattern: "(1\\.2\\.3)" } };
  await writeFile(path.join(f.home, "apps", "alpha.json"), JSON.stringify(recipe));
  for (const entry of await f.apps.load()) if (entry.file.endsWith("alpha.json")) await f.apps.approve(entry);
  // A changed recipe needs approval again.
  if (kind === "approve") await writeFile(f.file, (await readFile(f.file, "utf8")).replace("update demo", "update demo again"));
  f.view.unmount();
  const view = render(<App operations={f.operations} environment={f.environment} />);
  deferCleanup(t, () => view.unmount());
  resizeTerminal(view, { columns: 80, rows: 24 });
  await waitForFrame(view.lastFrame, text => /alpha/.test(text) && /demo/.test(text));
  view.stdin.write("d");
  await readPreview(view, /Remove recipe for alpha\? y\/n/u);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Removed App recipe/);
  await waitForSettled(view.lastFrame);
  view.stdin.write("d");
  return view;
}

for (const kind of ["approve", "uninstall-confirm", "uninstall-manual"] as const) {
  test(`the ${kind} preview of a recipe stands alone in the whole App: no earlier notice sits above it`, async t => {
    const view = await removalAfterNotice(t, kind);
    if (kind !== "approve") {
      await waitForFrame(view.lastFrame, /Uninstall it before/u);
      view.stdin.write("y");
    }
    const frame = await waitForFrame(view.lastFrame, /read [█░]* ?\d+%|read ✓/u);
    assert.doesNotMatch(frame, /Removed App recipe/);
    assert.ok(frame.split("\n").length <= 24, frame);
  });
}
