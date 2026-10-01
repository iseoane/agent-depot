import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { waitForFrame } from "./wait-for-frame.js";

interface FixtureSetup {
  readonly home: string;
  readonly apps: ReturnType<typeof createAppOperations>;
  readonly appEnvironment: AppEnvironment;
  readonly commands: string[];
}

async function fixture(
  t: TestContext,
  failure?: "spawn" | "exit",
  beforeRender?: (setup: FixtureSetup) => Promise<void>,
) {
  const home = await mkdtemp(path.join(tmpdir(), "tui-apps-"));
  const recipesDirectory = path.join(home, "state", "apps");
  await mkdir(recipesDirectory, { recursive: true });
  await writeFile(path.join(recipesDirectory, "demo.json"), JSON.stringify({
    name: "demo", install: { argv: ["demo", "install"], ...(failure ? { manual: "install demo yourself" } : {}) }, update: { argv: ["demo", "update"] },
    uninstall: { argv: ["demo", "uninstall"] }, version: { argv: ["demo", "version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    latest: { npm: "demo" }, setup: { pi: { argv: ["demo", "setup"] } }, teardown: { pi: { manual: "demo teardown manually" } },
  }));
  let installed = false;
  const commands: string[] = [];
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory,
    resolveExecutable: async () => "/usr/bin/demo",
    fetch: async () => { throw new Error("Latest must not run in Installations"); },
    runner: async (_exe, args) => {
      commands.push(args.join(" "));
      if (args[0] === "install" && failure === "spawn") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (args[0] === "install" && failure === "exit") return { code: 1, signal: null, stdout: Buffer.from("failed installer"), stderr: "", outputTooLarge: false };
      if (args[0] === "install") installed = true;
      if (args[0] === "uninstall") installed = false;
      return { code: args[0] === "version" && !installed ? 1 : 0, signal: null, stdout: Buffer.from("1.0.0"), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  await beforeRender?.({ home, apps, appEnvironment, commands });
  const view = render(<InstallationsView operations={createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") })}
    environment={{ homeDirectory: home, projectRoot: home, appEnvironment }} listHeight={20} />);
  t.after(async () => { view.unmount(); await rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  return { view, apps, commands, home, installedManually: () => { installed = true; } };
}

test("Apps are visible without running unapproved commands or startup latest lookups", async t => {
  const { view, commands } = await fixture(t);
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)") && frame.includes("needs approval"));
  assert.equal(commands.length, 0);
});

async function selectDemo(view: ReturnType<typeof render>) {
  view.stdin.write("jjjj");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("demo")));
}

test("Enter approves all argv, i installs and u uninstalls only after y", async t => {
  const { view, apps, commands } = await fixture(t);
  await waitForFrame(view.lastFrame, frame => frame.includes("needs approval"));
  await selectDemo(view);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("Approve demo? y/n") && frame.includes("/usr/bin/demo"));
  assert.equal(commands.length, 0);
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("cancelled"));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("Approve demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("Approved demo"));
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  assert.ok(!commands.includes("install"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: installed 1.0.0"));
  assert.equal((await apps.trackedApps())[0]?.installedVersion, "1.0.0");
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, frame => frame.includes("uninstall demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: untracked"));
  assert.deepEqual(await apps.trackedApps(), []);
});

test("h reuses the checklist for setup and manual teardown; y checks version", async t => {
  const { view, apps, commands } = await fixture(t);
  const [entry] = await apps.load();
  await apps.approve(entry!);
  await apps.executeLifecycle(await apps.planLifecycle(entry!, "install"), true);
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, frame => frame.includes("checked = setup"));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("setup demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: completed"));
  assert.ok(commands.includes("setup"));
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, frame => frame.includes("checked = setup"));
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, frame => frame.includes("[ ] 1 pi"));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo teardown manually") && frame.includes("done, check now? y/n"));
  const before = commands.length;
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: completed") && !frame.includes("done, check now"));
  assert.equal(commands[before], "version");
  assert.ok(!commands.some(command => command.includes("teardown")));
});

test("marked Apps continue after an independent failure and show each outcome", async t => {
  const { view, apps, home } = await fixture(t);
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global) (1)"));
  const file = path.join(home, "state", "apps", "a-other.json");
  await writeFile(file, JSON.stringify({ name: "other", install: { manual: "install other yourself" }, update: { manual: "update other" }, uninstall: { manual: "remove other" }, version: { argv: ["other", "version"], pattern: "(\\d+\\.\\d+\\.\\d+)" } }));
  // Approving demo causes a reload which discovers the second recipe.
  await waitForFrame(view.lastFrame, frame => frame.includes("needs approval"));
  await selectDemo(view);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("Approve demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global) (2)") && frame.includes("Approved demo"));
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, frame => frame.includes("2 selected"));
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: installed 1.0.0") && frame.includes("other: failed: needs approval"));
  assert.equal((await apps.trackedApps())[0]?.name, "demo");
});

test("changed and invalid recipes cannot execute through the TUI", async t => {
  const { view, apps, commands } = await fixture(t);
  const [entry] = await apps.load();
  await apps.approve(entry!);
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  await writeFile(entry!.file, "{}");
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("invalid recipe:") && frame.includes("demo: failed:"));
  assert.ok(!commands.includes("install"));
  assert.deepEqual(await apps.trackedApps(), []);
});

test("approved Apps stay cached at startup and version checks are lazy on focus", async t => {
  const { view, commands } = await fixture(t, undefined, async ({ apps, commands }) => {
    const [entry] = await apps.load();
    await apps.approve(entry!);
    await apps.executeLifecycle(await apps.planLifecycle(entry!, "install"), true);
    commands.length = 0;
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  assert.deepEqual(commands, []);
  await selectDemo(view);
  await waitForFrame(view.lastFrame, frame => frame.includes("demo  1.0.0") && commands.length === 1);
  assert.deepEqual(commands, ["version"]);
  view.stdin.write("kj");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("demo")));
  assert.deepEqual(commands, ["version"]);
});

test("approval detects changed content and allows reviewing the fresh recipe", async t => {
  const { view, apps } = await fixture(t);
  const [entry] = await apps.load();
  const recipe = { ...entry!.recipe!, install: { argv: ["missing", "install"], manual: "install demo yourself" } };
  await writeFile(entry!.file, JSON.stringify(recipe));
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("Approve demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("Recipe changed"));
  // Retry the fresh recipe after the approval drift guard reloads the tree.
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo yourself"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("Approved demo"));
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: installed"));
});

for (const failure of ["spawn", "exit"] as const) {
  test(`${failure} failure ${failure === "spawn" ? "offers manual completion" : "never falls back to manual"}`, async t => {
    const { view, apps, installedManually } = await fixture(t, failure);
    await waitForFrame(view.lastFrame, frame => frame.includes("needs approval"));
    await selectDemo(view);
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, frame => frame.includes("Approve demo? y/n"));
    view.stdin.write("y");
    await waitForFrame(view.lastFrame, frame => frame.includes("Approved demo"));
    view.stdin.write("i");
    await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
    view.stdin.write("y");
    if (failure === "exit") {
      await waitForFrame(view.lastFrame, frame => frame.includes("failed installer"));
      assert.ok(!view.lastFrame()!.includes("done, check now"));
      assert.deepEqual(await apps.trackedApps(), []);
    } else {
      await waitForFrame(view.lastFrame, frame => frame.includes("Manual step done, check now? y/n"));
      assert.deepEqual(await apps.trackedApps(), []);
      installedManually();
      view.stdin.write("y");
      await waitForFrame(view.lastFrame, frame => frame.includes("demo: installed 1.0.0"));
      assert.equal((await apps.trackedApps())[0]?.installedVersion, "1.0.0");
    }
  });
}

async function writeSkill(home: string) {
  const directory = path.join(home, ".agents", "skills", "sample");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: sample\ndescription: Sample skill\n---\n");
}

test("an unreadable App tracking directory does not hide Skill rows", async t => {
  const { view, commands } = await fixture(t, undefined, async ({ home }) => {
    await writeSkill(home);
    // readdir on a file makes the real trackedApps operation fail.
    await writeFile(path.join(home, "state", "app-installations"), "not a directory");
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("sample") && frame.includes("Apps (user-global)") && frame.includes("ENOTDIR"));
  assert.equal(commands.length, 0);
});
