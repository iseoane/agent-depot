import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
} from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillCandidate, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
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

/** Opens the first Source of the expanded first group and highlights its Skill. */
async function revealSkill(lastFrame: () => string | undefined, stdin: Stdin): Promise<void> {
  await moveDownTo(lastFrame, stdin, /> .*builtin:agent-depot/);
  stdin.write("\r");
  await waitForFrame(lastFrame, /portable\/demo/);
  await moveDownTo(lastFrame, stdin, /> .*portable\/demo/);
}

test("key 3 opens the Installations view, listed in the header and footer hints", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("3");
  const frame = await waitForFrame(lastFrame, /Managed \(user-global\) \(1\)/);
  assert.match(frame, /\[3 Installations\]/);
  assert.match(frame, /A adopt/);
  assert.match(frame, /2 Catalog/);
  stdin.write("1");
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  unmount();
});

test("u on a user-global installation opens the Catalog uninstall flow for that Skill", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("3");
  await waitForFrame(lastFrame, /builtin:agent-depot \(1\)/);
  await revealSkill(lastFrame, stdin);
  stdin.write("u");
  const frame = await waitForFrame(lastFrame, /Uninstall demo\? y\/n/);
  assert.match(frame, /\[2 Catalog\]/);
  assert.match(frame, /removes the whole user-global installation/);
  unmount();
});

test("i on an installation with missing hosts opens the Catalog host flow", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("3");
  await waitForFrame(lastFrame, /builtin:agent-depot \(1\)/);
  await revealSkill(lastFrame, stdin);
  stdin.write("i");
  const frame = await waitForFrame(lastFrame, /1 add hosts/);
  assert.match(frame, /\[2 Catalog\]/);
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
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  stdin.write("3");
  await waitForFrame(lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await moveDownTo(lastFrame, stdin, /> .*Unmanaged \(user-global\)/);
  stdin.write("\r");
  await waitForFrame(lastFrame, /demo2 {2}unmanaged/);
  await moveDownTo(lastFrame, stdin, /> .*demo2/);
  stdin.write("A");
  await waitForFrame(lastFrame, /Host \(space/);
  stdin.write("q");
  stdin.write("1");
  const frame = await waitForFrame(lastFrame, /\[x\] 1 pi/);
  assert.equal(exits, 0);
  assert.match(frame, /\[3 Installations\]/);
  stdin.write("\u001B");
  await waitForFrame(lastFrame, /Adoption cancelled/);
  unmount();
});
