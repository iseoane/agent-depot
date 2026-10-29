import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { renderExpanded } from "./render-expanded.js";
import { waitForFrame, waitForSettled } from "./wait-for-frame.js";

async function fixture(t: TestContext, options: { readonly approved?: boolean; readonly installed?: boolean; readonly unknown?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "tui-apps-"));
  const recipesDirectory = path.join(home, "state", "apps");
  await mkdir(recipesDirectory, { recursive: true });
  await writeFile(path.join(recipesDirectory, "demo.json"), JSON.stringify({
    name: "demo",
    install: { argv: ["demo", "install"] },
    update: { argv: ["demo", "update"] },
    uninstall: { argv: ["demo", "uninstall"] },
    version: { argv: ["demo", "version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
  }));
  let installed = options.installed ?? false;
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = {
    homeDirectory: home,
    recipesDirectory,
    resolveExecutable: async () => options.unknown ? undefined : "/usr/bin/demo",
    runner: async (_exe, args) => {
      commands.push(args.join(" "));
      if (args[0] === "version") return installed
        ? { code: 0, signal: null, stdout: Buffer.from("1.2.3"), stderr: "", outputTooLarge: false }
        : { code: 1, signal: null, stdout: Buffer.from("not installed"), stderr: "", outputTooLarge: false };
      if (args[0] === "uninstall") installed = false;
      return { code: 0, signal: null, stdout: Buffer.from("done"), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  if (options.approved) {
    const [entry] = await apps.load();
    await apps.approve(entry!);
  }
  const view = await renderExpanded(
    <InstallationsView
      operations={createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") })}
      environment={{ homeDirectory: home, projectRoot: home, appEnvironment }}
      listHeight={20}
    />,
  );
  t.after(async () => {
    try {
      await waitForSettled(view.lastFrame);
    } finally {
      view.unmount();
      await rm(home, { recursive: true, force: true });
    }
  });
  return { view, apps, commands };
}

test("Installations excludes unapproved recipes without running their commands", async t => {
  const { view, commands } = await fixture(t);
  const frame = await waitForFrame(view.lastFrame, candidate => candidate.includes("Managed (project)"));
  assert.doesNotMatch(frame, /Apps \(user-global\)|demo/);
  assert.deepEqual(commands, []);
});

test("approved externally installed Apps remain visible without an Agent Depot record", async t => {
  const { view, apps, commands } = await fixture(t, { approved: true, installed: true });
  const frame = await waitForFrame(view.lastFrame, candidate => candidate.includes("demo  1.2.3") && candidate.includes("Apps (user-global)"));
  assert.deepEqual(commands, ["version"]);
  assert.deepEqual(await apps.trackedApps(), []);
  assert.match(frame, /Apps \(user-global\) \(1\)/);
});

test("Installations does not treat an unknown App inspection as installed", async t => {
  const { view, commands } = await fixture(t, { approved: true, installed: true, unknown: true });
  const frame = await waitForFrame(view.lastFrame, candidate => candidate.includes("Managed (project)"));
  assert.doesNotMatch(frame, /Apps \(user-global\)|demo/);
  assert.deepEqual(commands, []);
});
