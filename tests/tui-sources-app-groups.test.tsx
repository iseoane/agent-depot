import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";

import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { SourcesView } from "../src/tui/sources-view.js";
import { squash, waitForFrame, waitForSettled } from "./wait-for-frame.js";

const base = { install: { argv: ["x", "install"] }, update: { manual: "update x" }, uninstall: { argv: ["x", "remove"] },
  version: { argv: ["x", "version"], pattern: "(.*)" } };
const recipe = (name: string, platform?: string) => ({ name, ...base, ...(platform === undefined ? {} : { platform }) });

async function fixture(t: TestContext, platform: NodeJS.Platform, files: Record<string, object>, approve: readonly string[] = []) {
  const home = await mkdtemp(path.join(tmpdir(), "sources-app-groups-"));
  const directory = path.join(home, "state", "apps");
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), JSON.stringify(content));
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory: directory, platform,
    resolveExecutable: async name => `/usr/bin/${name}`,
    runner: async () => { throw new Error("No recipe command should run"); },
    fetch: async () => { throw new Error("No latest lookup should run"); } };
  const apps = createAppOperations(appEnvironment);
  for (const entry of await apps.load()) if (approve.includes(path.basename(entry.file))) await apps.approve(entry);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") });
  const view = render(<SourcesView operations={operations} environment={{ homeDirectory: home, projectRoot: home, appEnvironment }} />);
  t.after(async () => {
    try { await waitForSettled(view.lastFrame); } finally { view.unmount(); await rm(home, { recursive: true, force: true }); }
  });
  return { view, directory, home };
}

const TWO = { "codegraph.windows.json": recipe("codegraph", "windows"), "profile-aa-bb.json": recipe("codegraph", "linux") };

test("a Windows machine lists one row per App with its platform and status, other platforms after it, and no paths", async t => {
  const f = await fixture(t, "win32", TWO, ["codegraph.windows.json"]);
  const frame = await waitForFrame(f.view.lastFrame, /other platform/);
  const flat = squash(frame);
  assert.match(flat, /codegraphappwindows·✓approvedlinux\(otherplatform\)/);
  assert.equal(frame.split("\n").filter(line => line.includes("codegraph")).length >= 1, true);
  assert.equal([...flat.matchAll(/codegraphapp/g)].length, 1, frame);
  assert.ok(!flat.includes("codegraph.windows.json") && !flat.includes("profile-aa-bb"), "list rows hide recipe paths");
});

test("the same recipes on Linux put linux first", async t => {
  const f = await fixture(t, "linux", TWO, ["profile-aa-bb.json"]);
  const frame = await waitForFrame(f.view.lastFrame, /other platform/);
  assert.match(squash(frame), /codegraphapplinux·✓approvedwindows\(otherplatform\)/);
});

test("a recipe without a platform is one row showing its status and no path", async t => {
  const f = await fixture(t, "linux", { "solo.json": recipe("solo") }, ["solo.json"]);
  const frame = await waitForFrame(f.view.lastFrame, /solo/);
  assert.match(squash(frame), /soloapp✓approved/);
  assert.ok(!squash(frame).includes("solo.json"));
});

test("same-named recipes that both apply stay separate rows and an invalid recipe stays visible with its error", async t => {
  const f = await fixture(t, "linux", { "a.json": recipe("dup"), "b.json": recipe("dup"), "bad.json": {} });
  const frame = await waitForFrame(f.view.lastFrame, /invalid\s+recipe:/);
  assert.equal([...squash(frame).matchAll(/dupapp/g)].length, 2, frame);
  assert.match(frame, /Duplicate applicable App name/);
});

test("Enter on a grouped row previews every recipe with platform, status, file and the one used here", async t => {
  const f = await fixture(t, "win32", TWO, ["codegraph.windows.json"]);
  await waitForFrame(f.view.lastFrame, /other platform/);
  f.view.stdin.write("\r");
  const frame = await waitForFrame(f.view.lastFrame, /Recipe approval/);
  const flat = squash(frame);
  assert.ok(flat.includes("codegraph.windows.json") && flat.includes("profile-aa-bb.json"), frame);
  assert.match(flat, /windows·approved.*\(usedhere\)/);
  assert.match(flat, /linux·notapplicablehere/);
});

test("d on a grouped row asks which recipe file, and removes only the one chosen, including a non-applicable one", async t => {
  const f = await fixture(t, "win32", TWO, ["codegraph.windows.json"]);
  await waitForFrame(f.view.lastFrame, /other platform/);
  f.view.stdin.write("d");
  const picker = await waitForFrame(f.view.lastFrame, /Remove which recipe/);
  assert.ok(squash(picker).includes("1windows") && squash(picker).includes("2linux"), picker);
  f.view.stdin.write("2");
  await waitForFrame(f.view.lastFrame, /Delete recipe:/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Removed App recipe/);
  await assert.rejects(access(path.join(f.directory, "profile-aa-bb.json")));
  await access(path.join(f.directory, "codegraph.windows.json"));
});

test("clashing duplicate recipes show their own file name and the error names every file to repair", async t => {
  const f = await fixture(t, "linux", { "a.json": recipe("dup"), "b.json": recipe("dup") });
  const flat = squash(await waitForFrame(f.view.lastFrame, /Duplicate/));
  assert.ok(flat.includes("a.json·") && flat.includes("b.json·"), flat);
  assert.ok(flat.includes("(repaira.json,b.json)"), flat);
});

test("when no recipe of a name applies here, the row leads with the primary recipe's platform", async t => {
  const f = await fixture(t, "win32", { "only-linux.json": recipe("tool", "linux") });
  const frame = await waitForFrame(f.view.lastFrame, /not applicable here/);
  assert.match(squash(frame), /toolapplinux·notapplicablehere/);
});

test("the removal picker cancels with n and Esc, ignores an out-of-range digit and starts removal of the applicable recipe when it is picked", async t => {
  const f = await fixture(t, "win32", TWO, ["codegraph.windows.json"]);
  await waitForFrame(f.view.lastFrame, /other platform/);
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Remove which recipe/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, frame => /other platform/.test(frame) && !/Remove which recipe/.test(frame));
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Remove which recipe/);
  f.view.stdin.write("\u001b");
  await waitForFrame(f.view.lastFrame, frame => /other platform/.test(frame) && !/Remove which recipe/.test(frame));
  f.view.stdin.write("d");
  await waitForFrame(f.view.lastFrame, /Remove which recipe/);
  f.view.stdin.write("9");
  await waitForSettled(f.view.lastFrame);
  assert.match(f.view.lastFrame() ?? "", /Remove which recipe/);
  // The fixture runner refuses every command, so entering the removal flow for the applicable recipe stops at its version check.
  f.view.stdin.write("1");
  await waitForFrame(f.view.lastFrame, /Cannot verify App state/);
  await access(path.join(f.directory, "codegraph.windows.json"));
  await access(path.join(f.directory, "profile-aa-bb.json"));
});
