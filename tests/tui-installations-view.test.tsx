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
  type ProjectHost,
  type ProjectSkillSelection,
} from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillCandidate, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { InstallationsView, type CatalogFocus } from "../src/tui/installations-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";

const SKILL_MD = "---\nname: demo\ndescription: Demo skill\n---\n\nBody\n";
const tree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Buffer.from(SKILL_MD), executable: false },
];
const resolvedVersion = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };
const demo: SkillCandidate = { sourceId: BUILT_IN_SOURCE.id, path: "portable/demo", name: "demo", description: "Demo skill" };
const sourceAccess = {
  async readSkillTree() {
    return tree;
  },
  async readSkillTreeSnapshot() {
    return { files: tree, resolvedVersion };
  },
};

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
  readonly project: string;
  readonly manifestStore: ProjectManifestStore;
}

async function fixture(t: TestContext, discover: SkillCandidate[] = [demo]): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-inst-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-inst-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-inst-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = { ...real, discoverSkills: async () => discover };
  const manifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return {
    operations,
    home,
    project,
    manifestStore,
    environment: { homeDirectory: home, projectRoot: project, sourceAccess, projectManifestStore: manifestStore },
  };
}

function record(hosts: readonly ProjectHost[], adopted = false, skillPath = "portable/demo"): ProjectSkillSelection {
  return parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: skillPath,
      version: { policy: "latest" },
      hosts,
      installation: { path: `.agents/skills/${path.posix.basename(skillPath)}`, adopted, resolvedVersion, baseline: skillTreeBaseline(tree) },
    }],
  }).skills[0]!;
}

async function writeUnmanaged(home: string, content = SKILL_MD, name = "demo") {
  const directory = path.join(home, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), content, "utf8");
  return directory;
}

type Stdin = { write(data: string): void };
const press = (stdin: Stdin, data: string) => stdin.write(data);

const ENTER_KEY = ENTER;
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
const PAGE_DOWN = "\u001B[6~";

function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.startsWith("> ")) ?? "";
}

type View = ReturnType<typeof render>;

/** Presses one key and waits for the frame to change, so keystrokes never race the renderer. */
async function step(view: View, key: string): Promise<string> {
  const before = view.lastFrame();
  press(view.stdin, key);
  return waitForFrame(view.lastFrame, (frame) => frame !== before);
}

/** Moves the highlight down until the selected line matches. */
async function goto(view: View, pattern: RegExp): Promise<string> {
  let frame = view.lastFrame() ?? "";
  for (let moves = 0; !pattern.test(selectedLine(frame)); moves += 1) {
    assert.ok(moves < 40, `never highlighted ${pattern}:\n${frame}`);
    frame = await step(view, "j");
  }
  return frame;
}

/** Highlights a group and opens it, returning the frame with its children. */
async function open(view: View, pattern: RegExp): Promise<string> {
  await goto(view, pattern);
  return step(view, ENTER_KEY);
}

function mount(f: Fixture, extra: { onOpenCatalog?: (focus: CatalogFocus) => void; onCapturingChange?: (capturing: boolean) => void } = {}) {
  return render(
    <InstallationsView operations={f.operations} environment={f.environment} {...extra} />,
  );
}

test("shows a tree of scope, then Source, then Skills with counts, source and managed state on each leaf", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["claude", "codex"], true));
  await f.manifestStore.save(parseProjectManifest({ version: 1, skills: [record(["pi"], false, "portable/other")] }));
  const view = mount(f);
  const collapsed = await waitForFrame(view.lastFrame, /Managed \(project\) \(1\)/);
  assert.match(collapsed, /▾ Managed \(user-global\) \(1\)/);
  assert.match(collapsed, /▸ builtin:agent-depot \(1\)/);
  assert.match(collapsed, /Unmanaged \(user-global\) \(0\)/);
  assert.ok(!collapsed.includes("portable/demo"), "Sources start collapsed");
  assert.ok(collapsed.indexOf("Managed (user-global)") < collapsed.indexOf("Managed (project)"));
  const expanded = await open(view, /builtin:agent-depot/);
  const globalLine = expanded.split("\n").find((line) => line.includes("portable/demo")) ?? "";
  assert.match(globalLine, /managed by builtin:agent-depot/);
  assert.match(globalLine, /latest/);
  assert.match(globalLine, new RegExp(AGENT_DEPOT_PACKAGE_VERSION!.replace(/\./gu, "\\.")));
  assert.match(globalLine, /claude, codex/);
  assert.match(globalLine, /adopted/);
  await open(view, /Managed \(project\)/);
  const projectFrame = await open(view, /builtin:agent-depot \(1\)$/);
  const projectLine = projectFrame.split("\n").find((line) => line.includes("portable/other")) ?? "";
  assert.match(projectLine, /pi/);
  assert.ok(!projectLine.includes("adopted"));
  view.unmount();
});

test("Enter and the right arrow expand, the left arrow collapses or moves to the parent", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["pi"], false, "portable/alpha"));
  const view = mount(f);
  await waitForFrame(view.lastFrame, /▸ builtin:agent-depot \(1\)/);
  await goto(view, /builtin:agent-depot/);
  const opened = await step(view, RIGHT);
  assert.match(opened, /▾ builtin:agent-depot/);
  assert.match(opened, /portable\/alpha/);
  const child = await step(view, "j");
  assert.match(selectedLine(child), /portable\/alpha/);
  const parent = await step(view, LEFT);
  assert.match(selectedLine(parent), /builtin:agent-depot/);
  assert.match(parent, /portable\/alpha/, "moving to the parent keeps it open");
  const closed = await step(view, LEFT);
  assert.match(closed, /▸ builtin:agent-depot/);
  assert.ok(!closed.includes("portable/alpha"));
  const reopened = await step(view, ENTER_KEY);
  assert.match(reopened, /portable\/alpha/);
  view.unmount();
});

test("keys pressed in one burst act on the latest tree state", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["pi"], false, "portable/alpha"));
  const view = mount(f);
  await waitForFrame(view.lastFrame, /▸ builtin:agent-depot \(1\)/);
  press(view.stdin, "j");
  press(view.stdin, RIGHT);
  press(view.stdin, "j");
  await waitForFrame(view.lastFrame, (frame) => /portable\/alpha/.test(selectedLine(frame)));
  view.unmount();
});

test("shows loading, then the empty state", async (t) => {
  const f = await fixture(t);
  const { lastFrame, unmount } = mount(f);
  assert.match(lastFrame() ?? "", /Loading installations/);
  const frame = await waitForFrame(lastFrame, /Managed \(project\) \(0\)/);
  assert.match(frame, /Managed \(user-global\) \(0\)/);
  assert.match(frame, /Unmanaged \(user-global\) \(0\)/);
  unmount();
});

test("shows an error when the installation state cannot be read", async (t) => {
  const f = await fixture(t);
  const operations: SourceOperations = {
    ...f.operations,
    listUserGlobalInstallations: async () => {
      throw new Error("state is corrupt");
    },
  };
  const { lastFrame, unmount } = mount({ ...f, operations });
  await waitForFrame(lastFrame, /Error: state is corrupt/);
  unmount();
});

test("missing user-global operations are reported as not supported", async (t) => {
  const f = await fixture(t);
  const rest: SourceOperations = { ...f.operations };
  delete rest.addUserGlobalInstallation;
  delete rest.listUserGlobalInstallations;
  const { lastFrame, unmount } = mount({ ...f, operations: rest });
  await waitForFrame(lastFrame, /not supported/i);
  unmount();
});

test("j and k move the highlight across installations", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["pi"], false, "portable/alpha"));
  await f.operations.addUserGlobalInstallation!(record(["pi"], false, "portable/beta"));
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(2\)/);
  await open(view, /builtin:agent-depot/);
  await step(view, "j");
  assert.match(selectedLine(view.lastFrame() ?? ""), /portable\/alpha/);
  await step(view, "j");
  assert.match(selectedLine(view.lastFrame() ?? ""), /portable\/beta/);
  await step(view, "k");
  assert.match(selectedLine(view.lastFrame() ?? ""), /portable\/alpha/);
  view.unmount();
});

test("a long tree renders only the rows that fit, keeps the highlight visible and pages with PgDn", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 12; n += 1) {
    await f.operations.addUserGlobalInstallation!(record(["pi"], false, `portable/skill${String(n).padStart(2, "0")}`));
  }
  const view = render(<InstallationsView operations={f.operations} environment={f.environment} listHeight={5} />);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(12\)/);
  await open(view, /builtin:agent-depot/);
  const top = await waitForFrame(view.lastFrame, /1–5 of 16/);
  assert.equal(top.split("\n").filter((line) => /skill\d\d/.test(line)).length, 3);
  const paged = await step(view, PAGE_DOWN);
  assert.match(paged, /\d+–\d+ of 16/);
  assert.match(selectedLine(paged), /skill0[34]/);
  await step(view, PAGE_DOWN);
  await step(view, PAGE_DOWN);
  const end = await waitForFrame(view.lastFrame, /12–16 of 16/);
  assert.match(selectedLine(end), /Unmanaged/);
  view.unmount();
});

test("lists unmanaged user-global Skills in their own section", async (t) => {
  const f = await fixture(t);
  await writeUnmanaged(f.home);
  const { lastFrame, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /Unmanaged \(user-global\) \(1\)/);
  const line = frame.split("\n").find((candidate) => candidate.includes("unmanaged  ")) ?? "";
  assert.match(line, /demo/);
  assert.match(line, new RegExp(path.join(f.home, ".agents", "skills", "demo").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  unmount();
});

test("u and i on a user-global installation hand over to the Catalog flow; project rows refuse u", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["pi"]));
  await f.manifestStore.save(parseProjectManifest({ version: 1, skills: [record(["pi"], false, "portable/other")] }));
  const focuses: CatalogFocus[] = [];
  const view = mount(f, { onOpenCatalog: (focus) => focuses.push(focus) });
  const { lastFrame, stdin, unmount } = view;
  await waitForFrame(lastFrame, /builtin:agent-depot \(1\)/);
  await open(view, /builtin:agent-depot/);
  await goto(view, /portable\/demo/);
  press(stdin, "u");
  await waitForFrame(lastFrame, () => focuses.length === 1);
  press(stdin, "i");
  await waitForFrame(lastFrame, () => focuses.length === 2);
  assert.deepEqual(focuses.map((focus) => [focus.sourceId, focus.path, focus.action]), [
    [BUILT_IN_SOURCE.id, "portable/demo", "uninstall"],
    [BUILT_IN_SOURCE.id, "portable/demo", "install"],
  ]);
  await open(view, /Managed \(project\)/);
  await open(view, /builtin:agent-depot \(1\)$/);
  await goto(view, /portable\/other/);
  press(stdin, "u");
  await waitForFrame(lastFrame, /Project uninstall is not supported/);
  assert.equal(focuses.length, 2);
  unmount();
});

async function startAdoption(f: Fixture, keys: readonly string[] = [ENTER]) {
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await goto(view, /demo {2}unmanaged/);
  press(view.stdin, "A");
  await waitForFrame(view.lastFrame, /Adopt demo/);
  for (const data of keys) press(view.stdin, data);
  return view;
}

test("A adopts an identical unmanaged Skill after host, version, preview and y", async (t) => {
  const f = await fixture(t);
  const directory = await writeUnmanaged(f.home);
  const before = await readFile(path.join(directory, "SKILL.md"), "utf8");
  const captures: boolean[] = [];
  const view = render(
    <InstallationsView operations={f.operations} environment={f.environment} onCapturingChange={(value) => captures.push(value)} />,
  );
  const { lastFrame, stdin, unmount } = view;
  await waitForFrame(lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await goto(view, /demo {2}unmanaged/);
  press(stdin, "A");
  await waitForFrame(lastFrame, /Host \(space/);
  assert.equal(captures.at(-1), true);
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Version: 1 latest/);
  press(stdin, "1");
  const preview = await waitForFrame(lastFrame, /y\/n/);
  assert.match(preview, /can be adopted/);
  assert.ok(!preview.includes("ADDITIONAL HOST EXPOSURE"));
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /Managed \(user-global\) \(1\)/);
  assert.match(done, /Adopted Skill "demo"/);
  assert.match(done, /Unmanaged \(user-global\) \(0\)/);
  const [installed] = await f.operations.listUserGlobalInstallations!();
  assert.equal(installed?.installation?.adopted, true);
  assert.equal(await readFile(path.join(directory, "SKILL.md"), "utf8"), before);
  assert.equal(captures.at(-1), false);
  unmount();
});

test("adoption of a Skill whose content differs shows why and writes nothing", async (t) => {
  const f = await fixture(t);
  const directory = await writeUnmanaged(f.home, `${SKILL_MD}local edit\n`);
  const { lastFrame, stdin, unmount } = await startAdoption(f, [ENTER, "1"]);
  const frame = await waitForFrame(lastFrame, /Cannot adopt/);
  assert.match(frame, /does not match|content-mismatch/);
  assert.ok(!frame.includes("y/n"));
  press(stdin, "y");
  press(stdin, ESC);
  await waitForFrame(lastFrame, /Adoption cancelled/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  assert.equal(await readFile(path.join(directory, "SKILL.md"), "utf8"), `${SKILL_MD}local edit\n`);
  unmount();
});

test("adoption without a Source Skill of the same name explains why", async (t) => {
  const f = await fixture(t, []);
  await writeUnmanaged(f.home);
  const view = mount(f);
  const { lastFrame, stdin, unmount } = view;
  await waitForFrame(lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await goto(view, /demo {2}unmanaged/);
  press(stdin, "A");
  await waitForFrame(lastFrame, /No Source Skill named "demo"/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  unmount();
});

test("adopting with an extra host needs a separate exposure confirmation; n writes nothing", async (t) => {
  const f = await fixture(t);
  await writeUnmanaged(f.home);
  const view = mount(f);
  const { lastFrame, stdin, unmount } = view;
  await waitForFrame(lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await goto(view, /demo {2}unmanaged/);
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Host \(space/);
  // Defaults are the shared hosts; also selecting Claude (4th is opencode, 2nd is claude) exposes another location.
  press(stdin, "2");
  await waitForFrame(lastFrame, /\[x\] 2 claude/);
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Version: 1 latest/);
  press(stdin, "1");
  const preview = await waitForFrame(lastFrame, /y\/n/);
  assert.match(preview, /ADDITIONAL HOST EXPOSURE/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /--confirm-additional-host/);
  press(stdin, "n");
  await waitForFrame(lastFrame, /Adoption cancelled/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  unmount();
});

test("n at the preview cancels without writing", async (t) => {
  const f = await fixture(t);
  await writeUnmanaged(f.home);
  const { lastFrame, stdin, unmount } = await startAdoption(f, [ENTER, "1"]);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "n");
  await waitForFrame(lastFrame, /Adoption cancelled/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  unmount();
});
