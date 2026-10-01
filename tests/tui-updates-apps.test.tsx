import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { UpdatesView } from "../src/tui/updates-view.js";
import { waitForFrame } from "./wait-for-frame.js";

async function fixture(t: TestContext, manual: boolean | "spawn" = false) {
  const home = await mkdtemp(path.join(tmpdir(), "updates-apps-"));
  const recipesDirectory = path.join(home, "state", "apps");
  await mkdir(recipesDirectory, { recursive: true });
  await writeFile(path.join(recipesDirectory, "demo.json"), JSON.stringify({
    name: "demo", install: { manual: "install demo" }, uninstall: { manual: "remove demo" },
    update: manual === true ? { manual: "upgrade demo yourself" } : { argv: ["demo", "update"], ...(manual === "spawn" ? { manual: "upgrade demo yourself" } : {}) },
    version: { argv: ["demo", "version"], pattern: "(\\S+)" }, latest: { npm: "demo" },
  }));
  let version = "1.0.0";
  let latestCalls = 0;
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory,
    resolveExecutable: async () => "/usr/bin/demo",
    fetch: async () => { latestCalls++; return new Response(JSON.stringify({ "dist-tags": { latest: "2.0.0" } })); },
    runner: async (_exe, args) => {
      commands.push(args.join(" "));
      if (args[0] === "update" && manual === "spawn") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (args[0] === "update") version = "2.0.0";
      return { code: 0, signal: null, stdout: Buffer.from(version), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  const [entry] = await apps.load();
  await apps.approve(entry!);
  const view = render(<UpdatesView operations={createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") })}
    environment={{ homeDirectory: home, projectRoot: home, appEnvironment }} />);
  t.after(async () => { view.unmount(); view.cleanup(); await rm(home, { recursive: true, force: true }); });
  return { view, apps, commands, latestCalls: () => latestCalls, setVersion: (next: string) => { version = next; } };
}

test("App updates preview the loaded check and apply verified versions", async t => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, frame => frame.includes("demo") && frame.includes("1.0.0 -> 2.0.0"));
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("1 selected"));
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("Apply 1 update? y/n"));
  assert.equal(f.latestCalls(), 1);
  assert.ok(!f.commands.includes("update"));
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("Update summary: 1 updated, 0 failed"));
  assert.equal((await f.apps.trackedApps())[0]?.installedVersion, "2.0.0");
});

for (const version of ["v1.0.0+build", "1.5.0"]) {
  test(`manual App updates verify normalized version change: ${version}`, async t => {
    const f = await fixture(t, true);
    await waitForFrame(f.view.lastFrame, frame => frame.includes("1.0.0 -> 2.0.0"));
    f.view.stdin.write("a");
    await waitForFrame(f.view.lastFrame, frame => frame.includes("1 selected"));
    f.view.stdin.write("\r");
    await waitForFrame(f.view.lastFrame, frame => frame.includes("Apply 1 update? y/n"));
    assert.equal(f.latestCalls(), 1);
    f.view.stdin.write("y");
    await waitForFrame(f.view.lastFrame, frame => frame.includes("upgrade demo yourself") && frame.includes("done, check now? y/n"));
    f.setVersion(version);
    f.view.stdin.write("y");
    const changed = version === "1.5.0";
    await waitForFrame(f.view.lastFrame, frame => frame.includes(changed
      ? "installed 1.0.0 -> 1.5.0 (latest 2.0.0)" : "version unchanged (1.0.0); expected 2.0.0"));
    assert.equal((await f.apps.trackedApps())[0]?.installedVersion, changed ? "1.5.0" : undefined);
    assert.ok(!f.commands.includes("update"));
  });
}

test("r rechecks Apps and folds unknown latest alongside unchecked recipes", async t => {
  const f = await fixture(t);
  await waitForFrame(f.view.lastFrame, frame => frame.includes("1.0.0 -> 2.0.0"));
  f.setVersion("2.0.0");
  f.view.stdin.write("r");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("1 up to date"));
  assert.equal(f.latestCalls(), 2);
  f.view.stdin.write("p");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("No installations"));
  f.view.stdin.write("g");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("1 up to date"));
  // Editing approved bytes invalidates approval without running another version command.
  const [entry] = await f.apps.load();
  await writeFile(entry!.file, "{}");
  const before = f.commands.length;
  f.view.stdin.write("r");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("1 cannot be checked"));
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("name: expected non-empty text"));
  assert.equal(f.commands.length, before);
});

test("spawn failure guides manual completion and declining continues the batch", async t => {
  const f = await fixture(t, "spawn");
  await waitForFrame(f.view.lastFrame, frame => frame.includes("1.0.0 -> 2.0.0"));
  f.view.stdin.write("a");
  await waitForFrame(f.view.lastFrame, /1 selected/);
  f.view.stdin.write("\r");
  await waitForFrame(f.view.lastFrame, /Apply 1 update/);
  f.view.stdin.write("y");
  await waitForFrame(f.view.lastFrame, /Manual step done, check now/);
  f.view.stdin.write("n");
  await waitForFrame(f.view.lastFrame, /Update summary: 0 updated, 1 failed/);
  assert.deepEqual(await f.apps.trackedApps(), []);
});
