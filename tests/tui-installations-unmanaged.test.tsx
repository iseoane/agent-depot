import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import { defaultProjectManifestPath, ProjectManifestStore } from "../src/project-manifest.js";
import { createSourceOperations, type SourceOperations } from "../src/sources.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import type { UnmanagedGroup } from "../src/tui/installations.js";
import { prepareUnmanagedRemoval, runUnmanagedRemoval } from "../src/tui/unmanaged-actions.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";
const SKILL_MD = "---\nname: no-mistakes\ndescription: Demo skill\n---\n\nBody\n";

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
  /** A directory outside the global roots, like a local development repository. */
  readonly dev: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "ad-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "ad-proj-"));
  const state = await mkdtemp(path.join(tmpdir(), "ad-state-"));
  const dev = await mkdtemp(path.join(tmpdir(), "ad-dev-"));
  t.after(async () => {
    await Promise.all([home, project, state, dev].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const projectManifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return { operations, home, dev, environment: { homeDirectory: home, projectRoot: project, projectManifestStore } };
}

const location = (home: string, root: ".agents" | ".claude", name: string) => path.join(home, root, "skills", name);
const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

async function writeSkill(home: string, root: ".agents" | ".claude", name: string, content = SKILL_MD): Promise<string> {
  const directory = location(home, root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), content, "utf8");
  return directory;
}

/** A skill directory under `dev`, and links to it from the given roots. */
async function linkSkill(f: Fixture, name: string, roots: readonly (".agents" | ".claude")[]): Promise<string> {
  const target = path.join(f.dev, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), SKILL_MD.replace("no-mistakes", name), "utf8");
  for (const root of roots) {
    await mkdir(path.dirname(location(f.home, root, name)), { recursive: true });
    await symlink(target, location(f.home, root, name), "dir");
  }
  return target;
}

type View = ReturnType<typeof render>;
const selectedLine = (frame: string) => frame.split("\n").find((line) => line.startsWith("> ")) ?? "";

function mount(f: Fixture) {
  return render(<InstallationsView operations={f.operations} environment={f.environment} />);
}

/** Moves down one row at a time until the selected line matches, waiting for each render. */
async function goto(view: View, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 30; moves += 1) {
    const frame = view.lastFrame() ?? "";
    if (pattern.test(selectedLine(frame))) return;
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, (next) => next !== frame);
  }
  assert.fail(`never highlighted ${pattern}:\n${view.lastFrame()}`);
}

/** Highlights the leaf of the Unmanaged group; it starts open when no other group has children. */
async function openUnmanaged(view: View, leaf: RegExp): Promise<string> {
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(\d+\)/);
  await goto(view, /Unmanaged/);
  if (!leaf.test(view.lastFrame() ?? "")) {
    view.stdin.write(ENTER);
    await waitForFrame(view.lastFrame, leaf);
  }
  await goto(view, leaf);
  return view.lastFrame() ?? "";
}

test("groups unmanaged entries by name as one leaf with the hosts of every location that holds it", async (t) => {
  const f = await fixture(t);
  await writeSkill(f.home, ".agents", "no-mistakes");
  await writeSkill(f.home, ".claude", "no-mistakes");
  const view = mount(f);
  const frame = await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  assert.match(frame, /Unmanaged \(user-global\) \(1\)/);
  const opened = await openUnmanaged(view, /no-mistakes \[/);
  assert.match(opened, /no-mistakes \[claude, pi, codex, opencode\]/);
  assert.equal(opened.split("\n").filter((line) => line.includes("no-mistakes")).length, 1);
  view.unmount();
});

test("a skill in one root lists only the hosts that read that root", async (t) => {
  const f = await fixture(t);
  await writeSkill(f.home, ".claude", "only-claude");
  const view = mount(f);
  const opened = await openUnmanaged(view, /only-claude \[/);
  assert.match(opened, /only-claude \[claude\]/);
  view.unmount();
});

test("shows symlinks with their target", async (t) => {
  const f = await fixture(t);
  const target = await linkSkill(f, "doctor-md-agents", [".agents", ".claude"]);
  const view = mount(f);
  const opened = await openUnmanaged(view, /doctor-md-agents \[/);
  assert.match(opened, /doctor-md-agents \[claude, pi, codex, opencode\]/);
  // The mark prefix can wrap a long temp path at the test width, so compare without whitespace.
  assert.ok(opened.replace(/\s+/g, "").includes(`symlink→${target}`.replace(/\s+/g, "")), opened);
  view.unmount();
});

test("u removes every location of an unmanaged skill after listing each exact path and warning", async (t) => {
  const f = await fixture(t);
  const agents = await writeSkill(f.home, ".agents", "no-mistakes");
  const claude = await writeSkill(f.home, ".claude", "no-mistakes");
  const view = mount(f);
  await openUnmanaged(view, /no-mistakes \[/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all locations.*2 choose locations/s);
  view.stdin.write("1");
  const preview = await waitForFrame(view.lastFrame, /Remove no-mistakes\? y\/n/);
  assert.ok(preview.includes(JSON.stringify(agents)), preview);
  assert.ok(preview.includes(JSON.stringify(claude)), preview);
  assert.match(preview, /agent-depot did not create these files/);
  assert.match(preview, /permanent deletion/);
  assert.equal(await exists(agents), true);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(0\)/);
  assert.match(done, /Removed .*ad-home-.*\.agents/s);
  assert.equal(await exists(agents), false);
  assert.equal(await exists(claude), false);
  view.unmount();
});

test("n at the preview removes nothing", async (t) => {
  const f = await fixture(t);
  const agents = await writeSkill(f.home, ".agents", "no-mistakes");
  const view = mount(f);
  await openUnmanaged(view, /no-mistakes \[/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /Remove no-mistakes\? y\/n/);
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /Uninstall cancelled/);
  assert.equal(await exists(agents), true);
  view.unmount();
});

test("the checklist removes only the chosen locations", async (t) => {
  const f = await fixture(t);
  const agents = await writeSkill(f.home, ".agents", "no-mistakes");
  const claude = await writeSkill(f.home, ".claude", "no-mistakes");
  const view = mount(f);
  await openUnmanaged(view, /no-mistakes \[/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /2 choose locations/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[ \] 1 .*\[ \] 2 /s);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Select at least one location/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[x\] 2 /);
  view.stdin.write(ENTER);
  const preview = await waitForFrame(view.lastFrame, /Remove no-mistakes\? y\/n/);
  assert.ok(preview.includes(JSON.stringify(claude)), preview);
  assert.ok(!preview.includes(JSON.stringify(agents)), preview);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Removed /);
  assert.equal(await exists(claude), false);
  assert.equal(await exists(agents), true);
  view.unmount();
});

test("removing a symlinked skill removes only the links and keeps the target", async (t) => {
  const f = await fixture(t);
  const target = await linkSkill(f, "doctor-md-agents", [".agents", ".claude"]);
  const view = mount(f);
  await openUnmanaged(view, /doctor-md-agents \[/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all locations/);
  view.stdin.write("1");
  const preview = await waitForFrame(view.lastFrame, /Remove doctor-md-agents\? y\/n/);
  assert.match(preview, /only the link is removed/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(0\)/);
  assert.equal(await exists(location(f.home, ".agents", "doctor-md-agents")), false);
  assert.equal(await exists(location(f.home, ".claude", "doctor-md-agents")), false);
  assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /doctor-md-agents/);
  view.unmount();
});

test("a Claude link to an unmanaged canonical skill is removed together with it", async (t) => {
  const f = await fixture(t);
  const agents = await writeSkill(f.home, ".agents", "no-mistakes");
  await mkdir(path.dirname(location(f.home, ".claude", "no-mistakes")), { recursive: true });
  await symlink(path.join("..", "..", ".agents", "skills", "no-mistakes"), location(f.home, ".claude", "no-mistakes"), "dir");
  const view = mount(f);
  const opened = await openUnmanaged(view, /no-mistakes \[/);
  assert.match(opened, /no-mistakes \[claude, pi, codex, opencode\]/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all locations/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /Remove no-mistakes\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(0\)/);
  assert.equal(await exists(agents), false);
  assert.equal(await exists(location(f.home, ".claude", "no-mistakes")), false);
  view.unmount();
});

test("a location that changed after the preview is kept and the others are still removed", async (t) => {
  const f = await fixture(t);
  const agents = await writeSkill(f.home, ".agents", "no-mistakes");
  const claude = await writeSkill(f.home, ".claude", "no-mistakes");
  const view = mount(f);
  await openUnmanaged(view, /no-mistakes \[/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /1 all locations/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /Remove no-mistakes\? y\/n/);
  await writeFile(path.join(agents, "SKILL.md"), `${SKILL_MD}edited after the preview\n`, "utf8");
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Failed .*changed before\s+deletion/s);
  assert.match(done, /Removed /);
  assert.equal(await exists(agents), true);
  assert.equal(await exists(claude), false);
  view.unmount();
});

test("keys without an action on the highlighted row explain why", async (t) => {
  const f = await fixture(t);
  await writeSkill(f.home, ".agents", "no-mistakes");
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await goto(view, /Managed \(user-global\)|Managed \(project\)/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /Uninstall is not available for group rows/);
  view.stdin.write("A");
  await waitForFrame(view.lastFrame, /Adoption is not available for group rows/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /Host changes are not available for group rows/);
  await openUnmanaged(view, /no-mistakes \[/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /Host changes are not available for unmanaged skills/);
  view.stdin.write("i");
  await waitForFrame(view.lastFrame, /Host changes are not available for unmanaged skills/);
  view.unmount();
});

test("adoption is not available for a symlink", async (t) => {
  const f = await fixture(t);
  await linkSkill(f, "doctor-md-agents", [".agents"]);
  const view = mount(f);
  await openUnmanaged(view, /doctor-md-agents \[/);
  view.stdin.write("A");
  await waitForFrame(view.lastFrame, /Adoption is not available for symlinks/);
  view.stdin.write(ESC);
  view.unmount();
});

/** Canonical unmanaged directory in `.agents` plus a relative Claude link to it. */
async function canonicalWithClaudeLink(f: Fixture): Promise<{ agents: string; claude: string }> {
  const agents = await writeSkill(f.home, ".agents", "no-mistakes");
  const claude = location(f.home, ".claude", "no-mistakes");
  await mkdir(path.dirname(claude), { recursive: true });
  await symlink(path.join("..", "..", ".agents", "skills", "no-mistakes"), claude, "dir");
  return { agents, claude };
}

test("choosing only the canonical directory also removes the Claude link that would dangle", async (t) => {
  const f = await fixture(t);
  const { agents, claude } = await canonicalWithClaudeLink(f);
  const view = mount(f);
  await openUnmanaged(view, /no-mistakes \[/);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /2 choose locations/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[ \] 1 .*\[ \] 2 /s);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /\[x\] 1 /);
  view.stdin.write(ENTER);
  const preview = await waitForFrame(view.lastFrame, /Remove no-mistakes\? y\/n/);
  assert.ok(preview.includes(`also removes link ${JSON.stringify(claude)}`), preview);
  assert.match(preview, /would dangle/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(0\)/);
  assert.equal(await exists(agents), false);
  assert.equal(await exists(claude), false);
  view.unmount();
});

test("a directory is kept when a link that targets it could not be removed", async (t) => {
  const f = await fixture(t);
  const { agents, claude } = await canonicalWithClaudeLink(f);
  const full: UnmanagedGroup = {
    name: "no-mistakes",
    hosts: ["claude", "pi", "codex", "opencode"],
    locations: [
      { path: agents, root: "agents" },
      { path: claude, root: "claude", linkTarget: path.join("..", "..", ".agents", "skills", "no-mistakes") },
    ],
  };
  const prepared = await prepareUnmanagedRemoval(f.operations, f.environment, full, [full.locations[0]!]);
  assert.ok(prepared.preview.some((line) => line.includes("also removes link")), prepared.preview.join("\n"));
  await rm(claude);
  await symlink(f.dev, claude, "dir");
  const result = await runUnmanagedRemoval(prepared, f.operations, f.environment);
  assert.equal(result.kind, "error");
  assert.ok(result.text.includes(`Skipped ${agents}: link ${claude} could not be removed`), result.text);
  assert.ok((await lstat(agents)).isDirectory());
  assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), SKILL_MD);
  assert.ok((await lstat(claude)).isSymbolicLink());
});
