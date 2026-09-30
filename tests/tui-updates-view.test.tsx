import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  type ProjectSkillSelection,
} from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { UpdatesView } from "../src/tui/updates-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";
const NEW_VERSION = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };
const OLD_VERSION = { kind: "builtin-package" as const, version: "0.0.1" };

const oldText = (name: string) => `---\nname: ${name}\ndescription: demo\n---\nold ${name}\n`;
const newText = (name: string) => `---\nname: ${name}\ndescription: demo\n---\nnew ${name}\n`;

function tree(name: string, content: string): readonly SkillTreeFile[] {
  return [{ path: `portable/${name}/SKILL.md`, content: Buffer.from(content), executable: false }];
}

interface SkillSpec {
  readonly name: string;
  /** `outdated` is updateable, `current` matches the Source, `unknown` has no version evidence. */
  readonly state: "outdated" | "current" | "unknown";
  readonly installPath?: string;
  readonly method?: readonly string[];
  /** Content on disk when it differs from the recorded baseline (a local modification). */
  readonly diskContent?: string;
}

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
  readonly project: string;
  readonly manifestStore: ProjectManifestStore;
  readonly readCalls: string[];
  readonly methodCalls: string[];
  readonly failMethodFor: Set<string>;
  read(root: string, installPath: string): Promise<string>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-upd-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-upd-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-upd-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const readCalls: string[] = [];
  const methodCalls: string[] = [];
  const failMethodFor = new Set<string>();
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = {
    ...real,
    async executeInstallationMethod(_method, context) {
      methodCalls.push(context.skillPath);
      if (failMethodFor.has(context.skillPath)) throw new Error(`method failed for ${context.skillPath}`);
    },
  };
  const sourceAccess = {
    async readSkillTree(_source: unknown, skillPath: string) {
      return tree(path.posix.basename(skillPath), newText(path.posix.basename(skillPath)));
    },
    async readSkillTreeSnapshot(_source: unknown, skillPath: string) {
      readCalls.push(skillPath);
      return { files: tree(path.posix.basename(skillPath), newText(path.posix.basename(skillPath))), resolvedVersion: NEW_VERSION };
    },
  };
  const manifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return {
    operations,
    home,
    project,
    manifestStore,
    readCalls,
    methodCalls,
    failMethodFor,
    environment: { homeDirectory: home, projectRoot: project, sourceAccess, projectManifestStore: manifestStore },
    read: (root, installPath) => readFile(path.join(root, installPath, "SKILL.md"), "utf8"),
  };
}

async function record(root: string, spec: SkillSpec): Promise<ProjectSkillSelection> {
  const installPath = spec.installPath ?? `.agents/skills/${spec.name}`;
  const installedContent = spec.state === "current" ? newText(spec.name) : oldText(spec.name);
  await mkdir(path.join(root, installPath), { recursive: true });
  await writeFile(path.join(root, installPath, "SKILL.md"), spec.diskContent ?? installedContent, "utf8");
  return parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: `portable/${spec.name}`,
      version: { policy: "latest" },
      hosts: ["pi"],
      ...(spec.method === undefined ? {} : { methods: { update: { kind: "command", argv: spec.method } } }),
      installation: {
        path: installPath,
        adopted: false,
        ...(spec.state === "unknown" ? {} : { resolvedVersion: spec.state === "current" ? NEW_VERSION : OLD_VERSION }),
        ...(spec.state === "unknown" ? {} : { baseline: skillTreeBaseline(tree(spec.name, installedContent)) }),
      },
    }],
  }).skills[0]!;
}

async function seedProject(f: Fixture, specs: readonly SkillSpec[]) {
  const skills = await Promise.all(specs.map((spec) => record(f.project, spec)));
  await f.manifestStore.save(parseProjectManifest({ version: 1, skills }));
}

type Stdin = { write(data: string): void };
const press = (stdin: Stdin, data: string) => stdin.write(data);

function mount(f: Fixture, extra: { onCapturingChange?: (capturing: boolean) => void } = {}) {
  return render(<UpdatesView operations={f.operations} environment={f.environment} {...extra} />);
}

test("lists project installations with current and available version, policy and status", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "outdated", state: "outdated" },
    { name: "fresh", state: "current" },
    { name: "mystery", state: "unknown" },
  ]);
  const { lastFrame, unmount } = mount(f);
  assert.match(lastFrame() ?? "", /Checking for updates/);
  const frame = await waitForFrame(lastFrame, /portable\/outdated/);
  assert.match(frame, /scope: project/);
  const outdated = frame.split("\n").find((line) => line.includes("portable/outdated")) ?? "";
  assert.match(outdated, /latest/);
  assert.match(outdated, /0\.0\.1/);
  assert.match(outdated, new RegExp(AGENT_DEPOT_PACKAGE_VERSION!.replace(/\./gu, "\\.")));
  assert.match(outdated, /update available/);
  assert.match(frame.split("\n").find((line) => line.includes("portable/fresh")) ?? "", /up to date/);
  const mystery = frame.split("\n").find((line) => line.includes("portable/mystery")) ?? "";
  assert.match(mystery, /cannot assess/);
  assert.match(frame, /no trustworthy resolved version evidence/);
  unmount();
});

test("shows the empty state and the error state", async (t) => {
  const f = await fixture(t);
  const empty = mount(f);
  await waitForFrame(empty.lastFrame, /No installations/);
  empty.unmount();

  const broken: Fixture = {
    ...f,
    environment: { ...f.environment, projectManifestStore: { load: async () => { throw new Error("manifest exploded"); } } as unknown as ProjectManifestStore },
  };
  const failing = mount(broken);
  await waitForFrame(failing.lastFrame, /Error: manifest exploded/);
  failing.unmount();
});

test("g and p switch the scope and r checks again", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "projonly", state: "outdated" }]);
  await f.operations.addUserGlobalInstallation!(await record(f.home, { name: "globalonly", state: "outdated" }));
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/projonly/);
  press(stdin, "g");
  const global = await waitForFrame(lastFrame, /portable\/globalonly/);
  assert.match(global, /scope: user-global/);
  assert.ok(!global.includes("portable/projonly"));
  press(stdin, "p");
  await waitForFrame(lastFrame, /portable\/projonly/);
  const before = f.readCalls.length;
  press(stdin, "r");
  await waitForFrame(lastFrame, () => f.readCalls.length > before);
  await waitForFrame(lastFrame, /portable\/projonly/);
  unmount();
});

test("space toggles updatable items only, a selects all of them, Enter needs a selection", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "fresh", state: "current" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Select at least one/);
  press(stdin, " ");
  await waitForFrame(lastFrame, /1 selected/);
  press(stdin, "j");
  press(stdin, "j");
  press(stdin, " ");
  press(stdin, "a");
  const frame = await waitForFrame(lastFrame, /2 selected/);
  assert.equal(frame.split("\n").filter((line) => line.includes("[x]")).length, 2);
  press(stdin, " ");
  unmount();
});

test("previews the update, writes nothing before y, then reports and reloads", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  const checkReads = f.readCalls.length;
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /Apply 1 update\? y\/n/);
  assert.equal(f.readCalls.length, checkReads, "the preview reuses the assessed snapshot instead of rereading or refreshing the Source");
  assert.match(preview, /Preview: update Skill "portable\/one"/);
  assert.match(preview, /proposed changes: replace 1 managed files/);
  assert.equal(await f.read(f.project, ".agents/skills/one"), oldText("one"));
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /1 updated, 0 failed/);
  assert.match(done, /Updated portable\/one/);
  assert.equal(await f.read(f.project, ".agents/skills/one"), newText("one"));
  await waitForFrame(lastFrame, (frame) => /up to date/.test(frame) && !/update available/.test(frame));
  unmount();
});

test("n cancels the preview and leaves the files untouched", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "n");
  await waitForFrame(lastFrame, /Update cancelled/);
  assert.equal(await f.read(f.project, ".agents/skills/one"), oldText("one"));
  unmount();
});

test("warns about local modifications in the preview", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", diskContent: "edited by hand" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /local modifications/);
  press(stdin, "n");
  assert.equal(await f.read(f.project, ".agents/skills/one"), "edited by hand");
  unmount();
});

test("previews the external command and runs it only after y", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", method: ["node", "--fake-update"] }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /external command/);
  assert.match(preview, /"--fake-update"/);
  assert.match(preview, /external cwd/);
  assert.deepEqual(f.methodCalls, []);
  press(stdin, "y");
  await waitForFrame(lastFrame, /1 updated, 0 failed/);
  assert.deepEqual(f.methodCalls, ["portable/one"]);
  unmount();
});

test("a non-canonical location needs a second confirmation naming the exact path", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", installPath: "tools/skills/one" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /non-canonical location "tools\/skills\/one"/);
  assert.ok(!preview.includes("--confirm-path"), "TUI wording does not mention CLI flags");
  press(stdin, "y");
  const second = await waitForFrame(lastFrame, /Confirm replacing non-canonical/);
  assert.match(second, /tools\/skills\/one/);
  assert.equal(await f.read(f.project, "tools/skills/one"), oldText("one"));
  press(stdin, "n");
  await waitForFrame(lastFrame, /Update cancelled/);
  assert.equal(await f.read(f.project, "tools/skills/one"), oldText("one"));

  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /Confirm replacing non-canonical/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /1 updated, 0 failed/);
  assert.equal(await f.read(f.project, "tools/skills/one"), newText("one"));
  unmount();
});

test("continues after one item fails and reports the reason per item", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "good", state: "outdated" },
    { name: "bad", state: "outdated", method: ["node", "--bad"] },
  ]);
  f.failMethodFor.add("portable/bad");
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/bad/);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /1 updated, 1 failed/);
  assert.match(done, /Updated portable\/good/);
  assert.match(done, /Failed portable\/bad: method failed for portable\/bad/);
  assert.equal(await f.read(f.project, ".agents/skills/good"), newText("good"));
  assert.equal(await f.read(f.project, ".agents/skills/bad"), oldText("bad"));
  unmount();
});

test("applies user-global updates through the same flow", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(await record(f.home, { name: "glob", state: "outdated" }));
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /No installations/);
  press(stdin, "g");
  await waitForFrame(lastFrame, /portable\/glob/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /Apply 1 update\? y\/n/);
  assert.match(preview, /scope: user-global/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /1 updated, 0 failed/);
  assert.equal(await f.read(f.home, ".agents/skills/glob"), newText("glob"));
  unmount();
});

test("reports capturing while previewing and not while browsing", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  const states: boolean[] = [];
  const { lastFrame, stdin, unmount } = mount(f, { onCapturingChange: (value) => states.push(value) });
  await waitForFrame(lastFrame, /portable\/one/);
  assert.equal(states.at(-1), false);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  assert.equal(states.at(-1), true);
  press(stdin, ESC);
  await waitForFrame(lastFrame, /Update cancelled/);
  assert.equal(states.at(-1), false);
  unmount();
});

test("key 4 opens the Updates view; q and number keys are ignored while confirming", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  let exited = false;
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} onExit={() => { exited = true; }} />);
  await waitForFrame(lastFrame, /4 Updates/);
  press(stdin, "4");
  await waitForFrame(lastFrame, /\[4 Updates\]/);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "q");
  press(stdin, "1");
  const frame = await waitForFrame(lastFrame, /Apply 1 update/);
  assert.match(frame, /\[4 Updates\]/);
  assert.equal(exited, false);
  press(stdin, "n");
  await waitForFrame(lastFrame, /Update cancelled/);
  press(stdin, "1");
  await waitForFrame(lastFrame, /\[1 Sources\]/);
  unmount();
});
