import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
} from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillCandidate, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { renderExpanded } from "./render-expanded.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const SKILL_MD = "---\nname: demo\ndescription: Demo skill\n---\n\nBody\n";
const tree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Buffer.from(SKILL_MD), executable: false },
];
const demo: SkillCandidate = { sourceId: BUILT_IN_SOURCE.id, path: "portable/demo", name: "demo", description: "Demo skill" };

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
}

/** A user-global `demo` installation (files and record) under a temp home. */
async function fixture(t: TestContext, hosts: readonly ("pi" | "claude")[]): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-instapp-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-instapp-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-instapp-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = { ...real, discoverSkills: async () => [demo] };
  const canonical = path.join(home, ".agents", "skills", "demo");
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "SKILL.md"), SKILL_MD, "utf8");
  if (hosts.includes("claude")) {
    await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
    await symlink(path.join("..", "..", ".agents", "skills", "demo"), path.join(home, ".claude", "skills", "demo"), "dir");
  }
  await operations.addUserGlobalInstallation!(parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts,
      installation: {
        path: ".agents/skills/demo",
        adopted: false,
        resolvedVersion: { kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION! },
        baseline: skillTreeBaseline(tree),
      },
    }],
  }).skills[0]!);
  return {
    operations,
    home,
    environment: {
      homeDirectory: home,
      projectRoot: project,
      projectManifestStore: new ProjectManifestStore(defaultProjectManifestPath(project)),
    },
  };
}

type Stdin = { write(data: string): void };

interface AppFixture {
  readonly view: Awaited<ReturnType<typeof renderExpanded>>;
  readonly apps: ReturnType<typeof createAppOperations>;
  readonly commands: string[];
  readonly home: string;
  setVersion(version: string): void;
}

async function appFixture(
  t: TestContext,
  tracked = false,
  beforeRender?: (apps: ReturnType<typeof createAppOperations>, recipeFile: string, home: string) => Promise<void>,
  resolveExecutable: AppEnvironment["resolveExecutable"] = async name => `/fake-bin/${name}`,
): Promise<AppFixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-app-record-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-app-record-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-app-record-state-"));
  const recipes = path.join(state, "apps");
  await mkdir(recipes, { recursive: true });
  const recipeFile = path.join(recipes, "demo.json");
  await writeFile(recipeFile, JSON.stringify({
    name: "demo",
    install: { argv: ["demo", "install"] },
    update: { argv: ["demo", "update"] },
    uninstall: { argv: ["demo", "uninstall"] },
    version: { argv: ["demo", "--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    latest: { npm: "demo" },
    setup: { pi: { argv: ["demo", "setup"] } },
    teardown: { pi: { manual: "demo teardown manually" } },
  }));
  let installed = false;
  let reportedVersion = "1.0.0";
  const commands: string[] = [];
  const appEnvironment = {
    homeDirectory: home,
    recipesDirectory: recipes,
    resolveExecutable,
    fetch: async () => { throw new Error("Installations must not check latest"); },
    runner: async (_executable: string, args: readonly string[]) => {
      commands.push(args.join(" "));
      if (args[0] === "install") installed = true;
      else if (args[0] === "uninstall") installed = false;
      if (args[0] === "--version") return {
        code: installed ? 0 : 1, signal: null, stdout: Buffer.from(reportedVersion), stderr: "", outputTooLarge: false,
      };
      return { code: 0, signal: null, stdout: Buffer.from("done"), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  if (tracked) {
    const [entry] = await apps.load();
    await apps.approve(entry!);
    await apps.executeLifecycle(await apps.planLifecycle(entry!, "install"), true);
    commands.length = 0;
  }
  await beforeRender?.(apps, recipeFile, home);
  const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const view = await renderExpanded(<InstallationsView operations={operations} environment={{ homeDirectory: home, projectRoot: project, appEnvironment }} />);
  t.after(async () => {
    view.unmount();
    await Promise.all([home, project, state].map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
  });
  return { view, apps, commands, home, setVersion: version => { reportedVersion = version; } };
}

async function selectInstalledApp(view: Awaited<ReturnType<typeof renderExpanded>>) {
  for (let move = 0; move < 20; move += 1) {
    const frame = view.lastFrame() ?? "";
    const selected = frame.split("\n").find(line => line.startsWith("> ")) ?? "";
    if (selected.includes("Apps (user-global)")) {
      if (selected.includes("▸")) view.stdin.write("\r");
      await waitForFrame(view.lastFrame, candidate => candidate.includes("demo  1.0.0"));
      view.stdin.write("j");
      await waitForFrame(view.lastFrame, candidate => candidate.split("\n").some(line => line.startsWith("> ") && line.includes("demo")));
      return;
    }
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, candidate => candidate !== frame);
  }
  assert.fail("App group was not reachable");
}

test("a tracked App stays cached at load and reconciles a newer version only when focused", async t => {
  const fixture = await appFixture(t, true);
  fixture.setVersion("2.0.0");
  const listed = await waitForFrame(fixture.view.lastFrame, /demo {2}1\.0\.0 \(recorded\)/);
  assert.deepEqual(fixture.commands, [], "loading an installation must not run version or latest commands");
  assert.match(listed, /Apps \(user-global\) \(1\)/);
  assert.equal((await fixture.apps.trackedApps())[0]?.installedVersion, "1.0.0");

  await selectInstalledApp(fixture.view);
  const focused = await waitForFrame(fixture.view.lastFrame, /demo {2}2\.0\.0/);
  assert.doesNotMatch(focused, /demo {2}2\.0\.0 \(recorded\)/);
  assert.deepEqual(fixture.commands, ["--version"]);
  assert.equal((await fixture.apps.trackedApps())[0]?.installedVersion, "2.0.0");
});

test("a changed recipe keeps a recorded Installation visible but blocks lifecycle commands", async t => {
  const fixture = await appFixture(t, true, async (_apps, recipeFile) => {
    await writeFile(recipeFile, JSON.stringify({
      name: "demo", install: { argv: ["demo", "install"] }, update: { argv: ["demo", "update"] },
      uninstall: { argv: ["demo", "uninstall"] }, version: { argv: ["demo", "--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
      homepage: "https://changed.example",
    }));
  });
  const listed = await waitForFrame(fixture.view.lastFrame, /demo {2}1\.0\.0 \(recorded\)/);
  assert.match(listed, /Apps \(user-global\) \(1\)/);
  await selectInstalledApp(fixture.view);
  assert.match(fixture.view.lastFrame() ?? "", /demo {2}1\.0\.0 \(recorded\)/);
  fixture.view.stdin.write("u");
  const blocked = await waitForFrame(fixture.view.lastFrame, /needs approval/);
  assert.match(blocked, /demo {2}1\.0\.0 \(recorded\)/);
  assert.deepEqual(fixture.commands, []);
  assert.equal((await fixture.apps.trackedApps())[0]?.installedVersion, "1.0.0");
});

test("manual App setup and teardown remain separate confirmed Host actions", async t => {
  const fixture = await appFixture(t, true);
  await selectInstalledApp(fixture.view);
  fixture.view.stdin.write("h");
  await waitForFrame(fixture.view.lastFrame, /Checked = setup/i);
  fixture.view.stdin.write("\r");
  const setup = await waitForFrame(fixture.view.lastFrame, /setup demo\? y\/n/);
  assert.match(setup, /argv: \["demo","setup"\]/);
  fixture.view.stdin.write("y");
  await waitForFrame(fixture.view.lastFrame, /demo: completed/);
  assert.ok(fixture.commands.includes("setup"));

  fixture.view.stdin.write("h");
  await waitForFrame(fixture.view.lastFrame, /Checked = setup/i);
  fixture.view.stdin.write(" ");
  await waitForFrame(fixture.view.lastFrame, /\[ \] 1 pi/);
  fixture.view.stdin.write("\r");
  const teardown = await waitForFrame(fixture.view.lastFrame, /demo teardown manually[\s\S]*done, check now\? y\/n/);
  assert.match(teardown, /Manual:/);
  const before = fixture.commands.length;
  fixture.view.stdin.write("y");
  await waitForFrame(fixture.view.lastFrame, /demo: completed/);
  assert.equal(fixture.commands[before], "--version");
  assert.ok(!fixture.commands.includes("teardown"));
});

test("Esc cancels an App Host checklist and lifecycle preview without running commands", async t => {
  const fixture = await appFixture(t, true);
  await selectInstalledApp(fixture.view);
  fixture.view.stdin.write("h");
  await waitForFrame(fixture.view.lastFrame, /Checked = setup/i);
  fixture.view.stdin.write("\u001b");
  await waitForFrame(fixture.view.lastFrame, /App action cancelled/);
  fixture.view.stdin.write("u");
  await waitForFrame(fixture.view.lastFrame, /uninstall demo\? y\/n/);
  fixture.view.stdin.write("\u001b");
  await waitForFrame(fixture.view.lastFrame, /demo: cancelled/);
  assert.ok(!fixture.commands.includes("uninstall"));
});

/** Presses j until the selected line matches, waiting for each move to render. */
async function moveDownTo(lastFrame: () => string | undefined, stdin: Stdin, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    const frame = lastFrame() ?? "";
    if ((frame.split("\n").find((line) => line.startsWith("> ")) ?? "").match(pattern)) return;
    stdin.write("j");
    await waitForFrame(lastFrame, (next) => next !== frame);
  }
  assert.fail("selection never reached the expected line");
}

/** Presses k until the selected line matches. */
async function moveUpTo(lastFrame: () => string | undefined, stdin: Stdin, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    const frame = lastFrame() ?? "";
    if ((frame.split("\n").find(line => line.startsWith("> ")) ?? "").match(pattern)) return;
    stdin.write("k");
    await waitForFrame(lastFrame, next => next !== frame);
  }
  assert.fail("selection never reached the expected line");
}

/** Opens the first scope and Source, then highlights its Skill. */
async function revealSkill(lastFrame: () => string | undefined, stdin: Stdin): Promise<void> {
  await moveDownTo(lastFrame, stdin, /> .*Managed \(user-global\)/);
  stdin.write("\r");
  await waitForFrame(lastFrame, /builtin:agent-depot \(1\)/);
  await moveDownTo(lastFrame, stdin, /> .*builtin:agent-depot/);
  stdin.write("\r");
  await waitForFrame(lastFrame, /portable\/demo/);
  await moveDownTo(lastFrame, stdin, /> .*portable\/demo/);
}

test("App marks remain active when the cursor moves to an unmarked Skill", async t => {
  const fixture = await appFixture(t, true, async (_apps, _recipeFile, home) => {
    const skill = path.join(home, ".agents", "skills", "sample");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: sample\ndescription: Sample skill\n---\n");
  });
  await selectInstalledApp(fixture.view);
  fixture.view.stdin.write(" ");
  await waitForFrame(fixture.view.lastFrame, /1 Apps marked/);
  await moveUpTo(fixture.view.lastFrame, fixture.view.stdin, /> .*sample/);
  fixture.view.stdin.write("i");
  const preview = await waitForFrame(fixture.view.lastFrame, /install demo\? y\/n/);
  assert.match(preview, /1 Apps marked/);
  assert.ok(!fixture.commands.includes("install"));
  fixture.view.stdin.write("n");
  await waitForFrame(fixture.view.lastFrame, /demo: cancelled/);
});

for (const action of ["i", "u", "h"] as const) {
  test(`mixed App and Skill marks reject ${action} without running commands`, async t => {
    const fixture = await appFixture(t, true, async (_apps, _recipeFile, home) => {
      const skill = path.join(home, ".agents", "skills", "sample");
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), "---\nname: sample\ndescription: Sample skill\n---\n");
    });
    await selectInstalledApp(fixture.view);
    fixture.view.stdin.write(" ");
    await waitForFrame(fixture.view.lastFrame, /1 Apps marked/);
    fixture.view.stdin.write("a");
    await waitForFrame(fixture.view.lastFrame, /2 selected/);
    fixture.view.stdin.write(action);
    await waitForFrame(fixture.view.lastFrame, /Select Apps or Skills separately for bulk actions/);
    assert.ok(!fixture.commands.includes("uninstall"));
    assert.ok(!fixture.commands.includes("install"));
  });
}

test("an App without declared Host steps reports that state without running commands", async t => {
  const fixture = await appFixture(t, false, async (apps, recipeFile) => {
    const recipe = JSON.parse(await readFile(recipeFile, "utf8")) as Record<string, unknown>;
    delete recipe.setup;
    delete recipe.teardown;
    await writeFile(recipeFile, JSON.stringify(recipe));
    const [entry] = await apps.load();
    await apps.approve(entry!);
    await apps.executeLifecycle(await apps.planLifecycle(entry!, "install"), true);
  });
  await selectInstalledApp(fixture.view);
  fixture.view.stdin.write("h");
  await waitForFrame(fixture.view.lastFrame, /No declared Host steps/);
  assert.ok(!fixture.commands.includes("setup"));
  assert.ok(!fixture.commands.includes("teardown"));
});

test("App adoption explains that adoption applies to unmanaged Skills", async t => {
  const fixture = await appFixture(t, true);
  await selectInstalledApp(fixture.view);
  fixture.view.stdin.write("A");
  await waitForFrame(fixture.view.lastFrame, /Adoption applies to unmanaged Skills, not Apps/);
  assert.ok(!fixture.commands.includes("install"));
});

test("a failed focused check can be retried without treating its error as absence", async t => {
  let failNextCheck = false;
  const fixture = await appFixture(t, true, async () => { failNextCheck = true; }, async name => {
    if (failNextCheck) {
      failNextCheck = false;
      throw new Error("temporary resolution failure");
    }
    return `/fake-bin/${name}`;
  });
  await selectInstalledApp(fixture.view);
  const failed = await waitForFrame(fixture.view.lastFrame, /demo {2}unknown/);
  assert.doesNotMatch(failed, /demo {2}1\.0\.0/);
  assert.deepEqual(fixture.commands, [], "failed resolution must not be presented as installed or absent");
  fixture.view.stdin.write("k");
  await waitForFrame(fixture.view.lastFrame, frame => frame.split("\n").some(line => line.startsWith("> ") && line.includes("Apps (user-global)")));
  fixture.view.stdin.write("j");
  const retried = await waitForFrame(fixture.view.lastFrame, frame => frame.includes("demo  1.0.0")
    && !frame.includes("demo  1.0.0 (recorded)") && fixture.commands.length === 1);
  assert.match(retried, /demo {2}1\.0\.0/);
  assert.equal(failNextCheck, false);
  assert.deepEqual(fixture.commands, ["--version"]);
});

test("a rejected focused check from before a cancelled action cannot replace the result", async t => {
  let rejectOld!: (error: Error) => void;
  let deferNextCheck = false;
  let oldStarted = false;
  const oldResolution = new Promise<string>((_resolve, reject) => { rejectOld = reject; });
  const fixture = await appFixture(t, true, async () => { deferNextCheck = true; }, async name => {
    if (deferNextCheck) {
      deferNextCheck = false;
      oldStarted = true;
      return oldResolution;
    }
    return `/fake-bin/${name}`;
  });
  await selectInstalledApp(fixture.view);
  await waitForFrame(fixture.view.lastFrame, () => oldStarted);
  fixture.view.stdin.write("u");
  await waitForFrame(fixture.view.lastFrame, /uninstall demo\? y\/n/);
  fixture.view.stdin.write("n");
  await waitForFrame(fixture.view.lastFrame, /demo: cancelled/);
  rejectOld(new Error("stale resolution failure"));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(fixture.view.lastFrame()!.includes("demo: cancelled"));
  assert.ok(!fixture.view.lastFrame()!.includes("stale resolution failure"));
  assert.equal((await fixture.apps.trackedApps())[0]?.installedVersion, "1.0.0");
});

test("unreadable App tracking state does not hide independently discovered Skills", async t => {
  const fixture = await appFixture(t, false, async (_apps, recipeFile, home) => {
    const skill = path.join(home, ".agents", "skills", "sample");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: sample\ndescription: Sample skill\n---\n");
    const tracking = path.join(path.dirname(path.dirname(recipeFile)), "app-installations");
    await writeFile(tracking, "not a directory");
  });
  const frame = await waitForFrame(fixture.view.lastFrame, candidate => candidate.includes("sample") && candidate.includes("ENOTDIR"));
  assert.match(frame, /Apps \(user-global\) \(0\)/);
});

test("an approved recipe without a verified installation record is not listed as an Installation", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-uninstalled-app-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-uninstalled-app-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-uninstalled-app-state-"));
  const recipes = path.join(state, "apps");
  await mkdir(recipes, { recursive: true });
  t.after(async () => {
    await Promise.all([home, project, state].map(directory => rm(directory, { recursive: true, force: true })));
  });
  await writeFile(path.join(recipes, "gentle-shell-linux.json"), JSON.stringify({
    name: "gentle-shell",
    platform: "linux",
    install: { argv: ["npm", "install", "-g", "gentle-shell"] },
    update: { argv: ["npm", "update", "-g", "gentle-shell"] },
    uninstall: { argv: ["npm", "uninstall", "-g", "gentle-shell"] },
    version: { argv: ["gentle-shell", "--version"], pattern: "(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)" },
  }));
  const appEnvironment = {
    homeDirectory: home,
    recipesDirectory: recipes,
    resolveExecutable: async () => undefined,
  };
  const appOperations = createAppOperations(appEnvironment);
  const [entry] = await appOperations.load();
  assert.ok(entry);
  await appOperations.approve(entry);
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = { ...real, discoverSkills: async () => [demo] };
  const environment: TuiEnvironment = {
    homeDirectory: home,
    projectRoot: project,
    appEnvironment,
    projectManifestStore: new ProjectManifestStore(path.join(project, "agent-depot.json")),
  };
  const view = render(<InstallationsView operations={operations} environment={environment} />);
  try {
    const frame = await waitForFrame(view.lastFrame, /Managed \(user-global\)|Unmanaged/);
    assert.doesNotMatch(frame, /Apps \(user-global\)|gentle-shell/);
  } finally {
    view.unmount();
  }
});

test("key 3 opens the Installations view, listed in the header and footer hints", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  stdin.write("3");
  const frame = await waitForFrame(lastFrame, /Managed \(user-global\) \(1\)/);
  assert.match(frame, /▶ \[3\] Installations/);
  assert.match(frame, /A adopt/);
  assert.match(frame, /\[2\] Catalog/);
  stdin.write("1");
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  unmount();
});

test("u on a user-global installation runs the uninstall flow inside the Installations view", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  stdin.write("3");
  await waitForFrame(lastFrame, /Managed \(user-global\) \(1\)/);
  await revealSkill(lastFrame, stdin);
  stdin.write("u");
  const frame = await waitForFrame(lastFrame, /Uninstall demo\? y\/n/);
  assert.match(frame, /▶ \[3\] Installations/);
  assert.match(frame, /removes the whole user-global installation/);
  unmount();
});

test("h on an installation with missing hosts opens the host checklist without leaving the view", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  stdin.write("3");
  await waitForFrame(lastFrame, /Managed \(user-global\) \(1\)/);
  await revealSkill(lastFrame, stdin);
  stdin.write("h");
  const frame = await waitForFrame(lastFrame, /Add hosts to demo/);
  assert.match(frame, /▶ \[3\] Installations/);
  assert.match(frame, /\[ \] 1 claude/);
  unmount();
});

test("q and number keys are blocked while the adoption flow captures keys", async (t) => {
  const f = await fixture(t, ["pi"]);
  const unmanaged = path.join(f.home, ".claude", "skills", "demo2");
  await mkdir(unmanaged, { recursive: true });
  await writeFile(path.join(unmanaged, "SKILL.md"), SKILL_MD.replaceAll("demo", "demo2"), "utf8");
  const operations: SourceOperations = {
    ...f.operations,
    discoverSkills: async () => [demo, { ...demo, path: "portable/demo2", name: "demo2" }],
  };
  let exits = 0;
  const { lastFrame, stdin, unmount } = render(
    <App operations={operations} environment={f.environment} onExit={() => { exits += 1; }} />,
  );
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  stdin.write("3");
  await waitForFrame(lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await moveDownTo(lastFrame, stdin, /> .*Unmanaged \(user-global\)/);
  stdin.write("\r");
  await waitForFrame(lastFrame, /demo2 \[claude\]/);
  await moveDownTo(lastFrame, stdin, /> .*demo2/);
  stdin.write("A");
  await waitForFrame(lastFrame, /Host \(space/);
  stdin.write("q");
  stdin.write("1");
  const frame = await waitForFrame(lastFrame, /\[x\] 1 pi/);
  assert.equal(exits, 0);
  assert.match(frame, /▶ \[3\] Installations/);
  stdin.write("\u001B");
  await waitForFrame(lastFrame, /Adoption cancelled/);
  unmount();
});
