import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";
import { renderExpanded } from "./render-expanded.js";

import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  type ProjectHost,
} from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";

const SKILL_MD = "---\nname: demo\ndescription: Demo skill\n---\n\nBody\n";
const tree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Buffer.from(SKILL_MD), executable: false },
];

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
  readonly manifestStore: ProjectManifestStore;
}

const canonical = (home: string) => path.join(home, ".agents", "skills", "demo");
const claude = (home: string) => path.join(home, ".claude", "skills", "demo");
const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

/** A user-global `demo` installation (files and record) under a temp home; the fake manifest store keeps cwd untouched. */
async function fixture(t: TestContext, hosts: readonly ProjectHost[], withApps = false): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-manage-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-manage-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-manage-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  await mkdir(canonical(home), { recursive: true });
  await writeFile(path.join(canonical(home), "SKILL.md"), SKILL_MD, "utf8");
  if (hosts.includes("claude")) {
    await mkdir(path.dirname(claude(home)), { recursive: true });
    await symlink(path.join("..", "..", ".agents", "skills", "demo"), claude(home), "dir");
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
  const recipesDirectory = path.join(state, "apps");
  if (withApps) {
    await mkdir(recipesDirectory);
    await writeFile(path.join(recipesDirectory, "app.json"), JSON.stringify({
      name: "sample-app", install: { argv: ["sample-app", "install"] },
      update: { argv: ["sample-app", "update"] }, uninstall: { argv: ["sample-app", "uninstall"] },
      version: { argv: ["sample-app", "version"], pattern: "(.*)" },
    }));
  }
  const manifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return { operations, home, manifestStore, environment: { homeDirectory: home, projectRoot: project, projectManifestStore: manifestStore,
    appEnvironment: { recipesDirectory, resolveExecutable: async () => "/usr/bin/sample-app",
      runner: async () => { throw new Error("Skill actions must not run App commands"); } },
  } };
}

type View = ReturnType<typeof render>;
const hostsOf = async (operations: SourceOperations) => (await operations.listUserGlobalInstallations!())[0]?.hosts;
const selectedLine = (frame: string) => frame.split("\n").find((line) => line.startsWith("> ")) ?? "";

/** Presses j until the selected line matches, waiting for each move to render. */
async function moveDownTo(view: View, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 20; moves += 1) {
    const frame = view.lastFrame() ?? "";
    if (pattern.test(selectedLine(frame))) return;
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, (next) => next !== frame);
  }
  assert.fail("selection never reached the expected line");
}

/** Opens the Source group of the first scope and highlights the demo installation. */
async function revealSkill(view: View): Promise<void> {
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(1\)/);
  await moveDownTo(view, /builtin:agent-depot/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /portable\/demo/);
  await moveDownTo(view, /portable\/demo/);
}

function mount(f: Fixture, onCapturingChange?: (capturing: boolean) => void) {
  return renderExpanded(<InstallationsView operations={f.operations} environment={f.environment} onCapturingChange={onCapturingChange} />);
}

test("u on a single-host installation previews, confirms and removes it without leaving the view", async (t) => {
  const f = await fixture(t, ["pi"]);
  const view = await mount(f);
  await revealSkill(view);
  view.stdin.write("u");
  const preview = await waitForFrame(view.lastFrame, /Uninstall demo\? y\/n/);
  assert.match(preview, /removes the whole user-global installation, from hosts: pi/);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Removed demo/);
  assert.match(done, /Managed \(user-global\) \(0\)/);
  assert.equal(await exists(canonical(f.home)), false);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  view.unmount();
});

test("u on an installation with several hosts offers all hosts or a host checklist", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const view = await mount(f);
  await revealSkill(view);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all hosts.*2 choose hosts/s);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[ \] 1 pi.*\[ \] 2 claude/s);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[x\] 2 claude/);
  view.stdin.write(ENTER);
  const preview = await waitForFrame(view.lastFrame, /Remove hosts from demo\? y\/n/);
  assert.match(preview, /remove hosts claude from "portable\/demo"; remaining hosts: pi/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Removed hosts claude/);
  assert.equal(await exists(claude(f.home)), false);
  assert.ok(await exists(canonical(f.home)));
  assert.deepEqual(await hostsOf(f.operations), ["pi"]);
  view.unmount();
});

test("u with all hosts chosen removes the whole installation", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const view = await mount(f);
  await revealSkill(view);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all hosts/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /Uninstall demo\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Removed demo/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  view.unmount();
});

for (const trigger of ["h", "i"]) {
  test(`${trigger} adds only the missing hosts after two confirmations`, async (t) => {
    const f = await fixture(t, ["pi"]);
    const view = await mount(f);
    await revealSkill(view);
    view.stdin.write(trigger);
    const checklist = await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
    assert.ok(!/\d pi/.test(checklist));
    view.stdin.write("1");
    await waitForFrame(view.lastFrame, /\[x\] 1 claude/);
    view.stdin.write(ENTER);
    const preview = await waitForFrame(view.lastFrame, /Add hosts to demo\? y\/n/);
    assert.match(preview, /add hosts claude to "portable\/demo"/);
    assert.equal(await exists(claude(f.home)), false);
    view.stdin.write("y");
    await waitForFrame(view.lastFrame, /needs separate confirmation/);
    assert.equal(await exists(claude(f.home)), false);
    view.stdin.write("y");
    const done = await waitForFrame(view.lastFrame, /Added hosts claude/);
    assert.match(done, /pi, claude/);
    assert.ok(await exists(claude(f.home)));
    assert.deepEqual(await hostsOf(f.operations), ["pi", "claude"]);
    view.unmount();
  });
}

test("h on an installation that already has every host says so", async (t) => {
  const f = await fixture(t, ["pi", "claude", "codex", "opencode"]);
  const view = await mount(f);
  await revealSkill(view);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /already (has|exposed to) every host/i);
  view.unmount();
});

test("the manage flows capture keys and Esc cancels without changes", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const changes: boolean[] = [];
  const view = await mount(f, (value) => changes.push(value));
  await revealSkill(view);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all hosts/);
  assert.equal(changes.at(-1), true);
  view.stdin.write(ESC);
  await waitForFrame(view.lastFrame, /Uninstall cancelled/);
  assert.equal(changes.at(-1), false);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 codex/);
  view.stdin.write(ESC);
  await waitForFrame(view.lastFrame, /cancelled/i);
  assert.deepEqual(await hostsOf(f.operations), ["pi", "claude"]);
  view.unmount();
});

test("u and h ignore group rows and project installations stay read-only", async (t) => {
  const f = await fixture(t, ["pi"]);
  await f.manifestStore.save(parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/other",
      version: { policy: "latest" },
      hosts: ["pi"],
    }],
  }));
  const view = await mount(f);
  await waitForFrame(view.lastFrame, /Managed \(project\) \(1\)/);
  view.stdin.write("u");
  view.stdin.write("h");
  await moveDownTo(view, /Managed \(project\)/);
  view.stdin.write(ENTER);
  await moveDownTo(view, /builtin:agent-depot \(1\)$/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /portable\/other/);
  await moveDownTo(view, /portable\/other/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /Project uninstall is not supported/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /Project installations are managed with the CLI/);
  assert.deepEqual(await hostsOf(f.operations), ["pi"]);
  view.unmount();
});


for (const input of ["i", "u", "h"]) {
  test(`Skill ${input} keeps its existing flow when the Apps group is present`, async t => {
    const f = await fixture(t, ["pi"], true);
    const view = await mount(f);
    t.after(() => view.unmount());
    await revealSkill(view);
    assert.match(view.lastFrame()!, /Apps \(user-global\) \(1\)/);
    view.stdin.write(input);
    await waitForFrame(view.lastFrame, input === "u" ? /Uninstall demo\? y\/n/ : /Add hosts to demo/);
    view.stdin.write(ESC);
    await waitForFrame(view.lastFrame, /cancelled/);
    assert.deepEqual(await hostsOf(f.operations), ["pi"]);
  });
}
