import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { render } from "ink-testing-library";
import { renderExpanded } from "./render-expanded.js";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { createSourceOperations } from "../src/sources.js";
import { loadInstallations } from "../src/tui/installations.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { waitForFrame } from "./wait-for-frame.js";

interface FixtureSetup {
  readonly home: string;
  readonly apps: ReturnType<typeof createAppOperations>;
  readonly appEnvironment: AppEnvironment;
  readonly commands: string[];
  /** Changes what the installed binary reports, as an upgrade outside Agent Depot would. */
  setVersion(version: string): void;
}

async function fixture(
  t: TestContext,
  failure?: "spawn" | "exit",
  beforeRender?: (setup: FixtureSetup) => Promise<void>,
  resolveExecutable: AppEnvironment["resolveExecutable"] = async () => "/usr/bin/demo",
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
  let reportedVersion = "1.0.0";
  const commands: string[] = [];
  const setVersion = (version: string) => { reportedVersion = version; };
  const appEnvironment: AppEnvironment = { homeDirectory: home, recipesDirectory,
    resolveExecutable,
    fetch: async () => { throw new Error("Latest must not run in Installations"); },
    runner: async (_exe, args) => {
      commands.push(args.join(" "));
      if (args[0] === "install" && failure === "spawn") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (args[0] === "install" && failure === "exit") return { code: 1, signal: null, stdout: Buffer.from("failed installer"), stderr: "", outputTooLarge: false };
      if (args[0] === "install") installed = true;
      if (args[0] === "uninstall") installed = false;
      return { code: args[0] === "version" && !installed ? 1 : 0, signal: null, stdout: Buffer.from(reportedVersion), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  await beforeRender?.({ home, apps, appEnvironment, commands, setVersion });
  const view = await renderExpanded(<InstallationsView operations={createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") })}
    environment={{ homeDirectory: home, projectRoot: home, appEnvironment }} listHeight={20} />);
  t.after(async () => { view.unmount(); await rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  return { view, apps, commands, home, appEnvironment, setVersion, installedManually: () => { installed = true; } };
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

test("focusing a tracked App records the live version when the binary moved ahead", async t => {
  const { view, apps, commands, home, appEnvironment } = await fixture(t, undefined, async ({ apps, commands, setVersion }) => {
    const [entry] = await apps.load();
    await apps.approve(entry!);
    await apps.executeLifecycle(await apps.planLifecycle(entry!, "install"), true);
    setVersion("2.0.0");
    commands.length = 0;
  });
  const listed = await waitForFrame(view.lastFrame, frame => frame.includes("demo  1.0.0 (recorded)"));
  assert.ok(listed.includes("demo  1.0.0 (recorded)"), "the cached row does not say the version is recorded");
  assert.deepEqual(commands, []);
  assert.equal((await apps.trackedApps())[0]?.installedVersion, "1.0.0");

  await selectDemo(view);
  const probed = await waitForFrame(view.lastFrame, frame => frame.includes("demo  2.0.0") && !frame.includes("(recorded)"));
  assert.ok(probed.includes("demo  2.0.0"));
  assert.deepEqual(commands, ["version"]);
  assert.equal((await apps.trackedApps())[0]?.installedVersion, "2.0.0");

  // A reload reads the reconciled record, so the corrected version survives the view.
  const reloaded = await loadInstallations(
    createSourceOperations({ homeDirectory: home, statePath: path.join(home, "state", "sources.json") }),
    { homeDirectory: home, projectRoot: home, appEnvironment },
  );
  assert.equal(reloaded.apps?.[0]?.inspection.installedVersion, "2.0.0");
  assert.deepEqual(commands, ["version"]);
});

test("approval detects changed content and allows reviewing the fresh recipe", async t => {
  const { view, apps } = await fixture(t);
  await waitForFrame(view.lastFrame, frame => frame.includes("needs approval"));
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

for (const status of ["approved", "invalid"] as const) {
  test(`Enter on an ${status} App reports its state without an approval preview`, async t => {
    const { view, commands } = await fixture(t, undefined, async ({ apps }) => {
      const [entry] = await apps.load();
      if (status === "approved") await apps.approve(entry!);
      else await writeFile(entry!.file, "{}");
    });
    await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
    await selectDemo(view);
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, frame => status === "approved"
      ? frame.includes("demo is already approved")
      : frame.split("\n").some(line => line === "name: expected non-empty text"));
    assert.ok(!view.lastFrame()!.includes("Approve"));
    assert.ok(!commands.includes("install"));
  });
}

async function approveDemo({ apps }: FixtureSetup) {
  const [entry] = await apps.load();
  await apps.approve(entry!);
}

test("a failed lazy check can be retried by focusing the App again", async t => {
  let attempts = 0;
  const { view, commands } = await fixture(t, undefined, approveDemo, async () => {
    if (++attempts === 1) throw new Error("temporary resolution failure");
    return "/usr/bin/demo";
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  await waitForFrame(view.lastFrame, frame => frame.includes("temporary resolution failure"));
  view.stdin.write("k");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("Apps (user-global)")));
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo") && commands.includes("version"));
  assert.equal(attempts, 2);
});

test("a rejected lazy check from before a reload cannot overwrite the current footer", async t => {
  let rejectOld!: (error: Error) => void;
  let attempts = 0;
  const oldResolution = new Promise<string>((_resolve, reject) => { rejectOld = reject; });
  const { view } = await fixture(t, undefined, approveDemo, async () => ++attempts === 1 ? oldResolution : "/usr/bin/demo");
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  await waitForFrame(view.lastFrame, () => attempts === 1);
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: cancelled") && attempts >= 3);
  rejectOld(new Error("stale resolution failure"));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(view.lastFrame()!.includes("demo: cancelled"));
  assert.ok(!view.lastFrame()!.includes("stale resolution failure"));
});

test("App marks remain visible and take precedence over an unmarked Skill cursor", async t => {
  const { view, commands } = await fixture(t, undefined, async setup => {
    await writeSkill(setup.home);
    await approveDemo(setup);
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("sample") && frame.includes("Apps (user-global)"));
  view.stdin.write("jjjj");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("Apps (user-global)")));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo"));
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("demo")) && commands.includes("version"));
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, frame => frame.includes("1 Apps marked"));
  view.stdin.write("kk");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("sample")));
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  assert.ok(view.lastFrame()!.includes("1 Apps marked"));
  assert.ok(!commands.includes("install"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: cancelled"));
});

for (const input of ["i", "u", "h"]) {
  test(`mixed App and Skill marks reject ${input} without running commands`, async t => {
    const { view, commands } = await fixture(t, undefined, async ({ home }) => writeSkill(home));
    await waitForFrame(view.lastFrame, frame => frame.includes("sample") && frame.includes("Apps (user-global)"));
    view.stdin.write("jjjj");
    await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("Apps (user-global)")));
    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, frame => frame.includes("demo"));
    view.stdin.write("a");
    await waitForFrame(view.lastFrame, frame => frame.includes("2 selected"));
    view.stdin.write(input);
    await waitForFrame(view.lastFrame, frame => frame.includes("Select Apps or Skills separately for bulk actions"));
    assert.equal(commands.length, 0);
  });
}

test("Esc cancels the App Host checklist and a lifecycle confirmation without execution", async t => {
  const { view, commands } = await fixture(t, undefined, approveDemo);
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, frame => frame.includes("checked = setup"));
  view.stdin.write("\u001B");
  await waitForFrame(view.lastFrame, frame => frame.includes("App action cancelled"));
  assert.ok(!view.lastFrame()!.includes("checked = setup"));
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  view.stdin.write("\u001B");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: cancelled"));
  assert.ok(!commands.includes("install"));
  assert.ok(!commands.includes("setup"));
});

test("n midway through marked Apps skips a step and continues the batch", async t => {
  const { view, apps } = await fixture(t, undefined, async setup => {
    const [entry] = await setup.apps.load();
    await writeFile(path.join(setup.home, "state", "apps", "other.json"), JSON.stringify({ ...entry!.recipe, name: "other" }));
    for (const current of await setup.apps.load()) await setup.apps.approve(current);
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global) (2)"));
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, frame => frame.includes("2 selected"));
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, frame => frame.includes("install demo? y/n"));
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => frame.includes("install other? y/n"));
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, frame => frame.includes("demo: cancelled") && frame.includes("other: installed"));
  assert.deepEqual((await apps.trackedApps()).map(app => app.name), ["other"]);
});

test("h on an App without Host steps reports the missing declarations", async t => {
  const { view, commands } = await fixture(t, undefined, async ({ apps }) => {
    const [entry] = await apps.load();
    await writeFile(entry!.file, JSON.stringify({ ...entry!.recipe, setup: undefined, teardown: undefined }));
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, frame => frame.includes("No declared Host steps"));
  assert.equal(commands.length, 0);
});

test("A on an App explains that adoption applies to unmanaged Skills", async t => {
  const { view, commands } = await fixture(t);
  await waitForFrame(view.lastFrame, frame => frame.includes("Apps (user-global)"));
  await selectDemo(view);
  view.stdin.write("A");
  await waitForFrame(view.lastFrame, frame => frame.includes("Adoption applies to unmanaged Skills, not Apps"));
  assert.equal(commands.length, 0);
});

for (const failure of ["recipes", "inspection"]) {
  test(`an App ${failure} loading failure stays confined to the Apps group`, async t => {
    const { view } = await fixture(t, undefined, async ({ home, appEnvironment }) => {
      await writeSkill(home);
      if (failure === "recipes") {
        await rm(appEnvironment.recipesDirectory!, { recursive: true });
        await writeFile(appEnvironment.recipesDirectory!, "not a directory");
      }
    }, async () => {
      if (failure === "inspection") throw new Error("approval resolution unavailable");
      return "/usr/bin/demo";
    });
    await waitForFrame(view.lastFrame, frame => frame.includes("sample") && frame.includes("Apps (user-global) (0)")
      && frame.includes(failure === "recipes" ? "ENOTDIR" : "approval resolution unavailable"));
  });
}

test("recipes for another platform have no approvable App row", async t => {
  const { view, commands } = await fixture(t, undefined, async ({ apps }) => {
    const [entry] = await apps.load();
    await writeFile(entry!.file, JSON.stringify({
      ...entry!.recipe, platform: process.platform === "win32" ? "linux" : "windows",
    }));
  });
  await waitForFrame(view.lastFrame, frame => frame.includes("Managed (project)"));
  view.stdin.write("\r");
  assert.ok(!view.lastFrame()!.includes("demo"));
  assert.ok(!view.lastFrame()!.includes("Approve"));
  assert.equal(commands.length, 0);
});


test("missing lifecycle executable is named in the preview and failure", async t => {
  const { view, commands } = await fixture(t, undefined, async ({ apps }) => {
    const [entry] = await apps.load();
    await apps.approve(entry!);
  }, async () => undefined);
  await selectDemo(view);
  view.stdin.write("i");
  const preview = await waitForFrame(view.lastFrame, /install demo\? y\/n/);
  assert.match(preview, /"demo" not found in PATH/u);
  view.stdin.write("y");
  const failure = await waitForFrame(view.lastFrame, /Required executable "demo" for install/u);
  assert.match(failure, /PATH used by Agent Depot/u);
  assert.deepEqual(commands, []);
});
