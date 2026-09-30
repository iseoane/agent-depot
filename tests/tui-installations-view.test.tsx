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

function mount(f: Fixture, extra: { onOpenCatalog?: (focus: CatalogFocus) => void; onCapturingChange?: (capturing: boolean) => void } = {}) {
  return render(
    <InstallationsView operations={f.operations} environment={f.environment} {...extra} />,
  );
}

test("lists user-global and project installations grouped by scope with source, version, hosts and adopted flag", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["claude", "codex"], true));
  await f.manifestStore.save(parseProjectManifest({ version: 1, skills: [record(["pi"], false, "portable/other")] }));
  const { lastFrame, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /Project \(1\)/);
  assert.match(frame, /User-global \(1\)/);
  const globalLine = frame.split("\n").find((line) => line.includes("portable/demo")) ?? "";
  assert.match(globalLine, /builtin:agent-depot/);
  assert.match(globalLine, /latest/);
  assert.match(globalLine, new RegExp(AGENT_DEPOT_PACKAGE_VERSION!.replace(/\./gu, "\\.")));
  assert.match(globalLine, /claude, codex/);
  assert.match(globalLine, /adopted/);
  const projectLine = frame.split("\n").find((line) => line.includes("portable/other")) ?? "";
  assert.match(projectLine, /pi/);
  assert.ok(!projectLine.includes("adopted"));
  assert.ok(frame.indexOf("User-global") < frame.indexOf("Project"));
  unmount();
});

test("shows loading, then the empty state", async (t) => {
  const f = await fixture(t);
  const { lastFrame, unmount } = mount(f);
  assert.match(lastFrame() ?? "", /Loading installations/);
  const frame = await waitForFrame(lastFrame, /No installations/);
  assert.match(frame, /No unmanaged/);
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
  const { addUserGlobalInstallation: _add, listUserGlobalInstallations: _list, ...rest } = f.operations;
  const { lastFrame, unmount } = mount({ ...f, operations: rest });
  await waitForFrame(lastFrame, /not supported/i);
  unmount();
});

test("j and k move the highlight across installations", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["pi"], false, "portable/alpha"));
  await f.operations.addUserGlobalInstallation!(record(["pi"], false, "portable/beta"));
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /> .*portable\/alpha/);
  press(stdin, "j");
  await waitForFrame(lastFrame, /> .*portable\/beta/);
  press(stdin, "k");
  await waitForFrame(lastFrame, /> .*portable\/alpha/);
  unmount();
});

test("lists unmanaged user-global Skills in their own section", async (t) => {
  const f = await fixture(t);
  await writeUnmanaged(f.home);
  const { lastFrame, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /Unmanaged user-global \(1\)/);
  assert.match(frame, /demo/);
  assert.match(frame, new RegExp(path.join(f.home, ".agents", "skills", "demo").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  unmount();
});

test("u and i on a user-global installation hand over to the Catalog flow; project rows refuse u", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(record(["pi"]));
  await f.manifestStore.save(parseProjectManifest({ version: 1, skills: [record(["pi"], false, "portable/other")] }));
  const focuses: CatalogFocus[] = [];
  const { lastFrame, stdin, unmount } = mount(f, { onOpenCatalog: (focus) => focuses.push(focus) });
  await waitForFrame(lastFrame, /> .*portable\/demo/);
  press(stdin, "u");
  await waitForFrame(lastFrame, () => focuses.length === 1);
  press(stdin, "i");
  await waitForFrame(lastFrame, () => focuses.length === 2);
  assert.deepEqual(focuses.map((focus) => [focus.sourceId, focus.path, focus.action]), [
    [BUILT_IN_SOURCE.id, "portable/demo", "uninstall"],
    [BUILT_IN_SOURCE.id, "portable/demo", "install"],
  ]);
  press(stdin, "j");
  await waitForFrame(lastFrame, /> .*portable\/other/);
  press(stdin, "u");
  await waitForFrame(lastFrame, /Project uninstall is not supported/);
  assert.equal(focuses.length, 2);
  unmount();
});

async function startAdoption(f: Fixture, keys: readonly string[] = [ENTER]) {
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged user-global \(1\)/);
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
  const { lastFrame, stdin, unmount } = render(
    <InstallationsView operations={f.operations} environment={f.environment} onCapturingChange={(value) => captures.push(value)} />,
  );
  await waitForFrame(lastFrame, /Unmanaged user-global \(1\)/);
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
  const done = await waitForFrame(lastFrame, /User-global \(1\)/);
  assert.match(done, /Adopted Skill "demo"/);
  assert.match(done, /No unmanaged/);
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
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /Unmanaged user-global \(1\)/);
  press(stdin, "A");
  await waitForFrame(lastFrame, /No Source Skill named "demo"/);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  unmount();
});

test("adopting with an extra host needs a separate exposure confirmation; n writes nothing", async (t) => {
  const f = await fixture(t);
  await writeUnmanaged(f.home);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /Unmanaged user-global \(1\)/);
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
