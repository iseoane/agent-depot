import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
} from "../src/project-manifest.js";
import { skillTreeBaseline } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { InstallationsView } from "../src/tui/installations-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Demo skill\n---\n\nBody\n`;

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
  readonly manifestStore: ProjectManifestStore;
}

const agentsDir = (home: string, name: string) => path.join(home, ".agents", "skills", name);
const claudeDir = (home: string, name: string) => path.join(home, ".claude", "skills", name);
const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

async function fixture(t: TestContext): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-bulk-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-bulk-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-bulk-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const manifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return { operations, home, manifestStore, environment: { homeDirectory: home, projectRoot: project, projectManifestStore: manifestStore } };
}

/** A managed user-global installation (files and record) of `portable/<name>`. */
async function install(f: Fixture, name: string, hosts: readonly ProjectHost[]): Promise<void> {
  const content = skillMd(name);
  await mkdir(agentsDir(f.home, name), { recursive: true });
  await writeFile(path.join(agentsDir(f.home, name), "SKILL.md"), content, "utf8");
  if (hosts.includes("claude")) {
    await mkdir(path.dirname(claudeDir(f.home, name)), { recursive: true });
    await symlink(path.join("..", "..", ".agents", "skills", name), claudeDir(f.home, name), "dir");
  }
  await f.operations.addUserGlobalInstallation!(parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: `portable/${name}`,
      version: { policy: "latest" },
      hosts,
      installation: {
        path: `.agents/skills/${name}`,
        adopted: false,
        resolvedVersion: { kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION! },
        baseline: skillTreeBaseline([{ path: `portable/${name}/SKILL.md`, content: Buffer.from(content), executable: false }]),
      },
    }],
  }).skills[0]!);
}

async function unmanaged(f: Fixture, name: string): Promise<string> {
  const directory = agentsDir(f.home, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), skillMd(name), "utf8");
  return directory;
}

async function projectInstall(f: Fixture, name: string): Promise<void> {
  await f.manifestStore.save(parseProjectManifest({
    version: 1,
    skills: [{ source: { kind: "builtin", id: BUILT_IN_SOURCE.id }, path: `portable/${name}`, version: { policy: "latest" }, hosts: ["pi"] }],
  }));
}

type View = ReturnType<typeof render>;
const selectedLine = (frame: string) => frame.split("\n").find((line) => line.startsWith("> ")) ?? "";
const records = async (f: Fixture) => Object.fromEntries((await f.operations.listUserGlobalInstallations!()).map((record) => [record.path, record.hosts]));
const mount = (f: Fixture) => render(<InstallationsView operations={f.operations} environment={f.environment} />);

async function goto(view: View, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 40; moves += 1) {
    const frame = view.lastFrame() ?? "";
    if (pattern.test(selectedLine(frame))) return;
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, (next) => next !== frame);
  }
  assert.fail(`never highlighted ${pattern}:\n${view.lastFrame()}`);
}

async function goUpTo(view: View, pattern: RegExp): Promise<void> {
  for (let moves = 0; moves < 40; moves += 1) {
    const frame = view.lastFrame() ?? "";
    if (pattern.test(selectedLine(frame))) return;
    view.stdin.write("k");
    await waitForFrame(view.lastFrame, (next) => next !== frame);
  }
  assert.fail(`never highlighted ${pattern}:\n${view.lastFrame()}`);
}

/** Opens the given groups top-down and leaves the selection on the last one opened. */
async function open(view: View, groups: readonly RegExp[]): Promise<void> {
  for (const group of groups) {
    await goto(view, group);
    const before = view.lastFrame() ?? "";
    view.stdin.write(ENTER);
    await waitForFrame(view.lastFrame, (next) => next !== before);
  }
}

async function mark(view: View, leaf: RegExp): Promise<void> {
  await goto(view, leaf);
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, (frame) => /\[x\]/.test(selectedLine(frame)));
}

test("space marks a leaf, shows the count and toggles it off", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(1\)/);
  await open(view, [/builtin:agent-depot \(1\)/]);
  await mark(view, /portable\/alpha/);
  assert.match(view.lastFrame() ?? "", /1 selected/);
  view.stdin.write(" ");
  const cleared = await waitForFrame(view.lastFrame, (frame) => /\[ \] portable\/alpha/.test(frame));
  assert.doesNotMatch(cleared, /selected/);
  view.unmount();
});

test("space on a group row says to mark skills", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Managed \(user-global\) \(1\)/);
  view.stdin.write(" ");
  await waitForFrame(view.lastFrame, /Mark skills, not group rows/);
  view.unmount();
});

test("a marks every visible leaf, marks on collapsed rows stay counted, and a again clears the visible ones", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi"]);
  await unmanaged(f, "loose");
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await open(view, [/builtin:agent-depot \(2\)/, /Unmanaged/]);
  view.stdin.write("a");
  const all = await waitForFrame(view.lastFrame, /3 selected/);
  assert.equal((all.match(/\[x\]/g) ?? []).length, 3);
  // Collapse the Source group: its two marked leaves are hidden but still counted.
  await goUpTo(view, /builtin:agent-depot \(2\)/);
  view.stdin.write("\u001B[D");
  const collapsed = await waitForFrame(view.lastFrame, (frame) => !/portable\/alpha/.test(frame));
  assert.match(collapsed, /3 selected/);
  view.stdin.write("a");
  const rest = await waitForFrame(view.lastFrame, /2 selected/);
  assert.match(rest, /\[ \] loose/);
  view.unmount();
});

test("space and j in one burst mark the row that was highlighted when space was pressed", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(2\)/);
  await open(view, [/builtin:agent-depot \(2\)/]);
  await goto(view, /portable\/alpha/);
  view.stdin.write(" j ");
  const frame = await waitForFrame(view.lastFrame, /2 selected/);
  assert.match(frame, /\[x\] portable\/alpha/);
  assert.match(frame, /\[x\] portable\/beta/);
  view.unmount();
});

/** Two managed installs (one locally modified), an unmanaged skill and a project install, everything revealed and marked. */
async function markedEverything(t: TestContext) {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi", "claude"]);
  await install(f, "gamma", ["pi"]);
  await writeFile(path.join(agentsDir(f.home, "gamma"), "SKILL.md"), `${skillMd("gamma")}edited\n`, "utf8");
  const loose = await unmanaged(f, "loose");
  await projectInstall(f, "proj");
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await open(view, [/builtin:agent-depot \(3\)/, /Managed \(project\)/, /builtin:agent-depot \(1\)/, /Unmanaged/]);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /5 selected/);
  return { f, view, loose };
}

test("u with marks shows ONE combined preview with every path, warnings and the skipped project item", async (t) => {
  const { f, view, loose } = await markedEverything(t);
  view.stdin.write("u");
  const preview = await waitForFrame(view.lastFrame, /Uninstall 4 items\? y\/n/);
  for (const name of ["alpha", "beta", "gamma"]) assert.ok(preview.includes(agentsDir(f.home, name)), `${name} path in:\n${preview}`);
  assert.ok(preview.includes(claudeDir(f.home, "beta")), preview);
  assert.ok(preview.includes(JSON.stringify(loose)), preview);
  assert.match(preview, /locally modified/);
  assert.match(preview, /agent-depot did not create these files/);
  assert.match(preview, /Skipped portable\/proj \(project\): Project uninstall is not supported/);
  assert.equal(await exists(agentsDir(f.home, "alpha")), true);
  view.unmount();
});

test("y removes every marked managed and unmanaged skill, skips the project one and keeps its mark", async (t) => {
  const { f, view, loose } = await markedEverything(t);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /Uninstall 4 items\? y\/n/);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Removed portable\/alpha/);
  assert.match(done, /Removed portable\/beta/);
  assert.match(done, /Removed portable\/gamma/);
  assert.match(done, /Skipped portable\/proj \(project\)/);
  for (const name of ["alpha", "gamma"]) assert.equal(await exists(agentsDir(f.home, name)), false, name);
  assert.equal(await exists(agentsDir(f.home, "beta")), false);
  assert.equal(await exists(claudeDir(f.home, "beta")), false);
  assert.equal(await exists(loose), false);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  assert.equal((await f.manifestStore.load()).skills.length, 1);
  // Only the skipped project item is still marked.
  const frame = await waitForFrame(view.lastFrame, /1 selected/);
  assert.doesNotMatch(frame, /Managed \(user-global\) \(3\)/);
  view.unmount();
});

test("n on the combined preview cancels everything and keeps the marks", async (t) => {
  const { f, view, loose } = await markedEverything(t);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /Uninstall 4 items\? y\/n/);
  view.stdin.write("n");
  const frame = await waitForFrame(view.lastFrame, /Uninstall cancelled/);
  assert.match(frame, /5 selected/);
  for (const name of ["alpha", "beta", "gamma"]) assert.equal(await exists(agentsDir(f.home, name)), true, name);
  assert.equal(await exists(loose), true);
  assert.equal(Object.keys(await records(f)).length, 3);
  view.unmount();
});

test("one failing item does not stop the others and stays marked", async (t) => {
  const { f, view } = await markedEverything(t);
  view.stdin.write("u");
  await waitForFrame(view.lastFrame, /Uninstall 4 items\? y\/n/);
  // alpha changes after the preview, so its recheck refuses while the rest still apply.
  await writeFile(path.join(agentsDir(f.home, "alpha"), "SKILL.md"), "changed after the preview\n", "utf8");
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Failed portable\/alpha/);
  assert.match(done, /Removed portable\/beta/);
  assert.match(done, /Removed portable\/gamma/);
  assert.equal(await exists(agentsDir(f.home, "alpha")), true);
  assert.equal(await readFile(path.join(agentsDir(f.home, "alpha"), "SKILL.md"), "utf8"), "changed after the preview\n");
  assert.equal(await exists(agentsDir(f.home, "beta")), false);
  assert.equal(await exists(agentsDir(f.home, "gamma")), false);
  assert.deepEqual(Object.keys(await records(f)), ["portable/alpha"]);
  // The failed alpha and the skipped project item remain marked.
  await waitForFrame(view.lastFrame, /2 selected/);
  view.unmount();
});

test("u with only project installations marked explains that nothing can be uninstalled", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await projectInstall(f, "proj");
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Managed \(project\) \(1\)/);
  await open(view, [/Managed \(project\)/, /builtin:agent-depot \(1\)/]);
  await mark(view, /portable\/proj/);
  view.stdin.write("u");
  const frame = await waitForFrame(view.lastFrame, /Project uninstall is not supported/);
  assert.doesNotMatch(frame, /y\/n/);
  assert.equal(await exists(agentsDir(f.home, "alpha")), true);
  view.unmount();
});

/** alpha [pi], beta [pi, claude], full [all hosts], a project install and an unmanaged skill, all marked. */
async function markedForHosts(t: TestContext) {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi", "claude"]);
  await install(f, "full", ["claude", "pi", "codex", "opencode"]);
  await unmanaged(f, "loose");
  await projectInstall(f, "proj");
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await open(view, [/builtin:agent-depot \(3\)/, /Managed \(project\)/, /builtin:agent-depot \(1\)/, /Unmanaged/]);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /5 selected/);
  return { f, view };
}

test("h with marks asks the hosts once (the union of what is missing) and previews every item", async (t) => {
  const { f, view } = await markedForHosts(t);
  view.stdin.write("h");
  const checklist = await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  assert.match(checklist, /\[ \] 2 codex/);
  assert.match(checklist, /\[ \] 3 opencode/);
  assert.doesNotMatch(checklist, /\d pi/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /\[x\] 1 claude/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[x\] 2 codex/);
  view.stdin.write(ENTER);
  const preview = await waitForFrame(view.lastFrame, /Add hosts to 2 items\? y\/n/);
  // alpha lacks both; beta already has claude, so only codex is added to it.
  assert.match(preview, /add hosts claude, codex to "portable\/alpha"/);
  assert.match(preview, /add hosts codex to "portable\/beta"/);
  assert.match(preview, /Skipped portable\/full: already has every host/);
  assert.match(preview, /Skipped loose: Host changes are not available for unmanaged skills/);
  assert.match(preview, /Skipped portable\/proj \(project\): Project installations are managed with the CLI/);
  assert.equal(await exists(claudeDir(f.home, "alpha")), false);
  view.unmount();
});

test("y, then one exposure confirmation naming the items, adds the hosts to each item and unmarks them", async (t) => {
  const { f, view } = await markedForHosts(t);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /\[x\] 1 claude/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Add hosts to 1 item\? y\/n/);
  view.stdin.write("y");
  const exposure = await waitForFrame(view.lastFrame, /needs separate\s+confirmation/);
  assert.match(exposure, /portable\/alpha/);
  assert.equal(await exists(claudeDir(f.home, "alpha")), false);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Added hosts claude to portable\/alpha/);
  assert.ok(await exists(claudeDir(f.home, "alpha")));
  assert.deepEqual(await records(f), {
    "portable/alpha": ["pi", "claude"],
    "portable/beta": ["pi", "claude"],
    "portable/full": ["claude", "pi", "codex", "opencode"],
  });
  assert.match(done, /4 selected/);
  view.unmount();
});

test("several items are applied one after another against the moving records", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi", "claude"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(2\)/);
  await open(view, [/builtin:agent-depot \(2\)/]);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /2 selected/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /\[x\] 2 codex/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Add hosts to 2 items\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /needs separate\s+confirmation/);
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Added hosts codex to portable\/beta/);
  assert.match(done, /Added hosts codex to portable\/alpha/);
  assert.deepEqual(await records(f), { "portable/alpha": ["pi", "codex"], "portable/beta": ["pi", "claude", "codex"] });
  assert.doesNotMatch(done, /selected/);
  view.unmount();
});

test("n on the exposure confirmation cancels every item", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(2\)/);
  await open(view, [/builtin:agent-depot \(2\)/]);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /2 selected/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /\[x\] 1 claude/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Add hosts to 2 items\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /needs separate\s+confirmation/);
  view.stdin.write("n");
  const frame = await waitForFrame(view.lastFrame, /cancelled/i);
  assert.match(frame, /2 selected/);
  assert.equal(await exists(claudeDir(f.home, "alpha")), false);
  assert.equal(await exists(claudeDir(f.home, "beta")), false);
  assert.deepEqual(await records(f), { "portable/alpha": ["pi"], "portable/beta": ["pi"] });
  view.unmount();
});

test("n on the combined host preview cancels every item", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(1\)/);
  await open(view, [/builtin:agent-depot \(1\)/]);
  await mark(view, /portable\/alpha/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /\[x\] 1 claude/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Add hosts to 1 item\? y\/n/);
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, /cancelled/i);
  assert.equal(await exists(claudeDir(f.home, "alpha")), false);
  assert.deepEqual(await records(f), { "portable/alpha": ["pi"] });
  view.unmount();
});

test("a host addition that fails does not stop the other items and stays marked", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  await install(f, "beta", ["pi"]);
  const view = mount(f);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(2\)/);
  await open(view, [/builtin:agent-depot \(2\)/]);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /2 selected/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /\[x\] 1 claude/);
  view.stdin.write(ENTER);
  await waitForFrame(view.lastFrame, /Add hosts to 2 items\? y\/n/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /needs separate\s+confirmation/);
  // A real directory now occupies alpha's Claude location, so its recheck refuses.
  await mkdir(claudeDir(f.home, "alpha"), { recursive: true });
  view.stdin.write("y");
  const done = await waitForFrame(view.lastFrame, /Failed portable\/alpha/);
  assert.match(done, /Added hosts claude to portable\/beta/);
  assert.deepEqual(await records(f), { "portable/alpha": ["pi"], "portable/beta": ["pi", "claude"] });
  assert.ok((await lstat(claudeDir(f.home, "beta"))).isSymbolicLink());
  assert.ok((await lstat(claudeDir(f.home, "alpha"))).isDirectory());
  assert.match(done, /1 selected/);
  view.unmount();
});

test("h with only unmanaged or complete items says why nothing can be added", async (t) => {
  const f = await fixture(t);
  await install(f, "full", ["claude", "pi", "codex", "opencode"]);
  await unmanaged(f, "loose");
  const view = mount(f);
  await waitForFrame(view.lastFrame, /Unmanaged \(user-global\) \(1\)/);
  await open(view, [/builtin:agent-depot \(1\)/, /Unmanaged/]);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /2 selected/);
  view.stdin.write("h");
  const frame = await waitForFrame(view.lastFrame, /already has every host/);
  assert.match(frame, /Host changes are not available for unmanaged skills/);
  assert.doesNotMatch(frame, /\[ \] 1/);
  view.unmount();
});

test("the bulk flows capture keys and Esc cancels the host checklist without changes", async (t) => {
  const f = await fixture(t);
  await install(f, "alpha", ["pi"]);
  const changes: boolean[] = [];
  const view = render(<InstallationsView operations={f.operations} environment={f.environment} onCapturingChange={(value) => changes.push(value)} />);
  await waitForFrame(view.lastFrame, /builtin:agent-depot \(1\)/);
  await open(view, [/builtin:agent-depot \(1\)/]);
  await mark(view, /portable\/alpha/);
  view.stdin.write("h");
  await waitForFrame(view.lastFrame, /\[ \] 1 claude/);
  assert.equal(changes.at(-1), true);
  view.stdin.write(ESC);
  await waitForFrame(view.lastFrame, /cancelled/i);
  assert.equal(changes.at(-1), false);
  assert.deepEqual(await records(f), { "portable/alpha": ["pi"] });
  view.unmount();
});
