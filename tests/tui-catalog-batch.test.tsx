import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import { defaultProjectManifestPath, ProjectManifestStore, AGENT_DEPOT_PACKAGE_VERSION } from "../src/project-manifest.js";
import type { SkillCandidate, SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const ENTER = "\r";
const NAMES = ["alpha", "beta", "gamma"] as const;
const resolvedVersion = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };

const skills: readonly SkillCandidate[] = NAMES.map((name) => ({
  sourceId: BUILT_IN_SOURCE.id,
  path: `portable/${name}`,
  name,
  description: `${name} skill`,
}));

const treeOf = (skillPath: string): readonly SkillTreeFile[] => [
  { path: `${skillPath}/SKILL.md`, content: Buffer.from(`## ${path.posix.basename(skillPath)}`), executable: false },
];

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
  readonly project: string;
}

/** `failRead` names skills whose Source read fails, so their preparation fails. */
async function fixture(t: TestContext, failRead: readonly string[] = []): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "ad-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "ad-proj-"));
  const state = await mkdtemp(path.join(tmpdir(), "ad-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = { ...real, discoverSkills: async () => skills };
  const read = async (_source: unknown, skillPath: string) => {
    if (failRead.includes(path.posix.basename(skillPath))) throw new Error(`cannot read ${skillPath}`);
    return treeOf(skillPath);
  };
  const sourceAccess = {
    readSkillTree: read,
    readSkillTreeSnapshot: async (source: unknown, skillPath: string) => ({ files: await read(source, skillPath), resolvedVersion }),
  };
  const projectManifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return { operations, home, project, environment: { homeDirectory: home, projectRoot: project, sourceAccess, projectManifestStore } };
}

type View = ReturnType<typeof render>;
const selectedLine = (frame: string) => frame.split("\n").find((line) => line.startsWith("> ")) ?? "";
const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

function mount(f: Fixture): View {
  return render(<CatalogView operations={f.operations} sourceId={BUILT_IN_SOURCE.id} environment={f.environment} />);
}

/** Presses a key and waits until the frame changes, so keys never race the renderer. */
async function step(view: View, data: string): Promise<string> {
  const before = view.lastFrame();
  view.stdin.write(data);
  return waitForFrame(view.lastFrame, (frame) => frame !== before);
}

/** Waits for the list and moves the highlight onto the named skill. */
async function highlight(view: View, name: string): Promise<string> {
  let frame = await waitForFrame(view.lastFrame, /alpha skill/);
  for (let moves = 0; !new RegExp(`> .*${name} `).test(selectedLine(frame) + " "); moves += 1) {
    assert.ok(moves < 10, `never highlighted ${name}:\n${frame}`);
    frame = await step(view, "j");
  }
  return frame;
}

/** Host, scope and version steps: hosts by number, then scope and version keys. */
async function choose(view: View, hostKeys: readonly string[], scopeKey: string, versionKey: string): Promise<void> {
  await waitForFrame(view.lastFrame, /Host \(space/);
  for (const hostKey of hostKeys) await step(view, hostKey);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Scope:/);
  view.stdin.write(scopeKey);
  await waitForFrame(view.lastFrame, /Version:/);
  view.stdin.write(versionKey);
}

test("marks a skill that has an unmanaged copy on disk and keeps it installable", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, ".agents", "skills", "alpha"), { recursive: true });
  await writeFile(path.join(f.home, ".agents", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha\n---\n", "utf8");
  const dev = await mkdtemp(path.join(tmpdir(), "ad-dev-"));
  t.after(() => rm(dev, { recursive: true, force: true }));
  await writeFile(path.join(dev, "SKILL.md"), "---\nname: beta\ndescription: Beta\n---\n", "utf8");
  await mkdir(path.join(f.home, ".claude", "skills"), { recursive: true });
  await symlink(dev, path.join(f.home, ".claude", "skills", "beta"), "dir");
  const view = mount(f);
  const frame = await waitForFrame(view.lastFrame, /alpha skill/);
  const line = (name: string) => frame.split("\n").find((candidate) => candidate.includes(`${name} skill`)) ?? "";
  assert.match(line("alpha"), /on disk, unmanaged · adopt it from Installations/);
  assert.match(line("beta"), /on disk, unmanaged · adopt it from Installations/);
  assert.ok(!line("gamma").includes("unmanaged"));
  await highlight(view, "alpha");
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, /Install alpha\./);
  view.unmount();
});

test("an unmanaged copy with different content is decided by the install collision rules", async (t) => {
  const f = await fixture(t);
  const existing = path.join(f.home, ".agents", "skills", "alpha");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "SKILL.md"), "---\nname: alpha\ndescription: Alpha\n---\nlocal\n", "utf8");
  const view = mount(f);
  await highlight(view, "alpha");
  view.stdin.write("i");
  await choose(view, ["1"], "2", "1");
  const frame = await waitForFrame(view.lastFrame, /Error|error|exist|collision/i);
  assert.ok(!/Installed Skill/.test(frame), frame);
  assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "---\nname: alpha\ndescription: Alpha\n---\nlocal\n");
  view.unmount();
});

test("space marks skills, a marks every visible skill and a again clears them", async (t) => {
  const f = await fixture(t);
  const view = mount(f);
  await highlight(view, "alpha");
  const marked = await step(view, " ");
  assert.match(marked, /\[x\] alpha/);
  assert.match(marked, /1 selected/);
  assert.match(marked, /\[ \] beta/);
  const all = await step(view, "a");
  assert.match(all, /3 selected/);
  assert.match(all, /\[x\] gamma/);
  const cleared = await step(view, "a");
  assert.ok(!/selected/.test(cleared), cleared);
  view.unmount();
});

test("space on a source row explains that skills are marked", async (t) => {
  const f = await fixture(t);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /alpha skill/);
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, /Mark skills, not source rows/);
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, /Install is not available for source rows/);
  view.unmount();
});

test("i installs the marked skills with one host, scope and version choice and one combined preview", async (t) => {
  const f = await fixture(t);
  const view = mount(f);
  await highlight(view, "alpha");
  await step(view, " ");
  await highlight(view, "gamma");
  await step(view, " ");
  view.stdin.write("i");
  const host = await waitForFrame(view.lastFrame, /Host \(space/);
  assert.match(host, /Install 2 skills\./);
  await choose(view, ["1"], "2", "1");
  const preview = await waitForFrame(view.lastFrame, /Install 2 skills\? y\/n/);
  assert.match(preview, /portable\/alpha\/SKILL\.md/);
  assert.match(preview, /portable\/gamma\/SKILL\.md/);
  assert.ok(!preview.includes("portable/beta/SKILL.md"));
  assert.equal(await exists(path.join(f.home, ".agents", "skills", "alpha")), false);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, (frame) => /Installed Skill "alpha"/.test(frame) && /Installed Skill "gamma"/.test(frame));
  assert.ok(!done.includes("alpha skill") && !done.includes("gamma skill"), "installed skills leave the list");
  assert.match(done, /beta skill/);
  assert.equal(await readFile(path.join(f.home, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), "## alpha");
  assert.equal(await readFile(path.join(f.home, ".agents", "skills", "gamma", "SKILL.md"), "utf8"), "## gamma");
  assert.equal((await f.operations.listUserGlobalInstallations!()).length, 2);
  view.unmount();
});

test("a project batch records every skill in the manifest", async (t) => {
  const f = await fixture(t);
  const view = mount(f);
  await highlight(view, "alpha");
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /3 selected/);
  view.stdin.write("i");
  await choose(view, ["3"], "1", "1");
  await waitForFrame(view.lastFrame, /Install 3 skills\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /All skills are installed/);
  const manifest = await new ProjectManifestStore(defaultProjectManifestPath(f.project)).load();
  assert.deepEqual(manifest.skills.map((entry) => entry.path).sort(), ["portable/alpha", "portable/beta", "portable/gamma"]);
  view.unmount();
});

test("a skill that cannot be prepared is shown in the preview and skipped while the others install", async (t) => {
  const f = await fixture(t, ["beta"]);
  const view = mount(f);
  await highlight(view, "alpha");
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /3 selected/);
  view.stdin.write("i");
  await choose(view, ["1"], "2", "1");
  const preview = await waitForFrame(view.lastFrame, /Install 2 skills\? y\/n/);
  assert.match(preview, /Cannot install beta: cannot read portable\/beta/);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Installed Skill "gamma"/);
  assert.match(done, /Failed beta: cannot read portable\/beta/);
  assert.equal(await exists(path.join(f.home, ".agents", "skills", "alpha")), true);
  assert.equal(await exists(path.join(f.home, ".agents", "skills", "beta")), false);
  view.unmount();
});

test("one item failing while installing does not stop the others", async (t) => {
  const f = await fixture(t);
  const real = f.operations;
  const operations: SourceOperations = {
    ...real,
    addUserGlobalInstallation: async (record) => {
      if (record.path === "portable/beta") throw new Error("state is locked");
      return real.addUserGlobalInstallation!(record);
    },
  };
  const view = mount({ ...f, operations });
  await highlight(view, "alpha");
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /3 selected/);
  view.stdin.write("i");
  await choose(view, ["1"], "2", "1");
  await waitForFrame(view.lastFrame, /Install 3 skills\? y\/n/);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Failed beta/);
  assert.match(done, /state is locked/);
  await waitForFrame(view.lastFrame, (frame) => /Installed Skill "gamma"/.test(frame));
  assert.equal(await exists(path.join(f.home, ".agents", "skills", "alpha")), true);
  assert.equal(await exists(path.join(f.home, ".agents", "skills", "gamma")), true);
  assert.equal(await exists(path.join(f.home, ".agents", "skills", "beta")), false);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /beta skill/, "the failed skill stays in the list");
  assert.ok(!frame.includes("alpha skill"));
  view.unmount();
});

test("one additional-host confirmation covers the items that need it; n installs nothing", async (t) => {
  const f = await fixture(t);
  const canonical = path.join(f.project, ".agents", "skills", "alpha");
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "SKILL.md"), "## alpha");
  const view = mount(f);
  await highlight(view, "alpha");
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /3 selected/);
  view.stdin.write("i");
  await choose(view, ["1", "2"], "1", "1");
  const preview = await waitForFrame(view.lastFrame, /Install 3 skills\? y\/n/);
  assert.match(preview, /ADDITIONAL HOST EXPOSURE/);
  view.stdin.write("y");
  const second = await waitForFrame(view.lastFrame, /--confirm-additional-host/);
  assert.match(second, /alpha/);
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /Install cancelled/);
  assert.deepEqual((await new ProjectManifestStore(defaultProjectManifestPath(f.project)).load()).skills, []);
  assert.equal(await exists(path.join(f.project, ".agents", "skills", "beta")), false);
  view.unmount();
});

test("i on the highlighted skill without marks installs just that skill", async (t) => {
  const f = await fixture(t);
  const view = mount(f);
  await highlight(view, "beta");
  view.stdin.write("i");
  const host = await waitForFrame(view.lastFrame, /Host \(space/);
  assert.match(host, /Install beta\./);
  view.unmount();
});
