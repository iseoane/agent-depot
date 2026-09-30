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
import { formatAgo, loadUpdateRows, prepareUpdates, runUpdates } from "../src/tui/updates.js";
import { App } from "../src/tui/app.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { UpdatesView } from "../src/tui/updates-view.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";
const NEW_VERSION = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };
const OLD_VERSION = { kind: "builtin-package" as const, version: "0.0.1" };
const NEWER_VERSION = { kind: "builtin-package" as const, version: "999.0.0" };
const GIT_NEW = { kind: "git-commit" as const, commit: "b".repeat(40) };
const GIT_OLD = { kind: "git-commit" as const, commit: "a".repeat(40) };
const GIT_URL = "https://example.com/skills.git";
const GIT_SOURCE = { id: "git:1234567890abcdef12345678", kind: "git" as const, url: GIT_URL };

const oldText = (name: string) => `---\nname: ${name}\ndescription: demo\n---\nold ${name}\n`;
const newText = (name: string) => `---\nname: ${name}\ndescription: demo\n---\nnew ${name}\n`;

function tree(name: string, content: string): readonly SkillTreeFile[] {
  return [{ path: `portable/${name}/SKILL.md`, content: Buffer.from(content), executable: false }];
}

interface SkillSpec {
  readonly name: string;
  /** `outdated` is updateable, `current` matches the Source, `unknown` has no version evidence. */
  readonly state: "outdated" | "current" | "unknown" | "newer";
  readonly installPath?: string;
  /** Git URL of the Skill's Source; the built-in Source when absent. */
  readonly url?: string;
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
  /** Ordered `refresh:<url>` and `read:<path>` events, to prove the refresh precedes the assessment. */
  readonly events: string[];
  readonly methodCalls: string[];
  readonly failMethodFor: Set<string>;
  /** Git URLs whose refresh fails with "network unreachable". */
  readonly failRefresh: Set<string>;
  /** While set, refreshes wait for it, so the busy state can be observed. */
  readonly gate: { promise?: Promise<void> };
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
  const events: string[] = [];
  const methodCalls: string[] = [];
  const failMethodFor = new Set<string>();
  const failRefresh = new Set<string>();
  const gate: { promise?: Promise<void> } = {};
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = {
    ...real,
    async resolveProjectSource(source) {
      return source.kind === "builtin" ? BUILT_IN_SOURCE : { ...GIT_SOURCE, url: "url" in source ? source.url : GIT_URL };
    },
    async refreshProjectSource(source) {
      const url = "url" in source ? source.url : "";
      events.push(`refresh:${url}`);
      if (gate.promise) await gate.promise;
      if (failRefresh.has(url)) throw new Error("network unreachable");
      return { ...GIT_SOURCE, url };
    },
    async executeInstallationMethod(_method, context) {
      methodCalls.push(context.skillPath);
      if (failMethodFor.has(context.skillPath)) throw new Error(`method failed for ${context.skillPath}`);
    },
  };
  const sourceAccess = {
    async readSkillTree(_source: unknown, skillPath: string) {
      return tree(path.posix.basename(skillPath), newText(path.posix.basename(skillPath)));
    },
    async readSkillTreeSnapshot(source: { readonly kind: string }, skillPath: string) {
      readCalls.push(skillPath);
      events.push(`read:${skillPath}`);
      return {
        files: tree(path.posix.basename(skillPath), newText(path.posix.basename(skillPath))),
        resolvedVersion: source.kind === "builtin" ? NEW_VERSION : GIT_NEW,
      };
    },
  };
  const manifestStore = new ProjectManifestStore(defaultProjectManifestPath(project));
  return {
    operations,
    home,
    project,
    manifestStore,
    readCalls,
    events,
    methodCalls,
    failMethodFor,
    failRefresh,
    gate,
    environment: { homeDirectory: home, projectRoot: project, sourceAccess, projectManifestStore: manifestStore },
    read: (root, installPath) => readFile(path.join(root, installPath, "SKILL.md"), "utf8"),
  };
}

async function record(root: string, spec: SkillSpec): Promise<ProjectSkillSelection> {
  const installPath = spec.installPath ?? `.agents/skills/${spec.name}`;
  const installedContent = spec.state === "current" ? newText(spec.name) : oldText(spec.name);
  await mkdir(path.join(root, installPath), { recursive: true });
  await writeFile(path.join(root, installPath, "SKILL.md"), spec.diskContent ?? installedContent, "utf8");
  const versions = spec.url === undefined
    ? { current: NEW_VERSION, old: spec.state === "newer" ? NEWER_VERSION : OLD_VERSION }
    : { current: GIT_NEW, old: GIT_OLD };
  return parseProjectManifest({
    version: 1,
    skills: [{
      source: spec.url === undefined ? { kind: "builtin", id: BUILT_IN_SOURCE.id } : { kind: "external", url: spec.url },
      path: `portable/${spec.name}`,
      version: { policy: "latest" },
      hosts: ["pi"],
      ...(spec.method === undefined ? {} : { methods: { update: { kind: "command", argv: spec.method } } }),
      installation: {
        path: installPath,
        adopted: false,
        ...(spec.state === "unknown" ? {} : { resolvedVersion: spec.state === "current" ? versions.current : versions.old }),
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

function mount(f: Fixture, extra: { onCapturingChange?: (capturing: boolean) => void; now?: () => number } = {}) {
  return render(<UpdatesView operations={f.operations} environment={f.environment} {...extra} />);
}

/** Seeds one global installation record under the fixture home. */
async function seedGlobal(f: Fixture, spec: SkillSpec) {
  await f.operations.addUserGlobalInstallation!(await record(f.home, spec));
}

test("lists only updatable items, counts the up-to-date ones and folds the unassessable into one line", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "outdated", state: "outdated" },
    { name: "fresh", state: "current" },
    { name: "fresher", state: "current" },
    { name: "mystery", state: "unknown" },
  ]);
  const { lastFrame, unmount } = mount(f);
  assert.match(lastFrame() ?? "", /Refreshing sources|Checking for updates/);
  const frame = await waitForFrame(lastFrame, /portable\/outdated/);
  assert.match(frame, /scope: all/);
  const outdated = frame.split("\n").find((line) => line.includes("portable/outdated")) ?? "";
  assert.match(outdated, /latest/);
  assert.match(outdated, /0\.0\.1/);
  assert.match(outdated, new RegExp(AGENT_DEPOT_PACKAGE_VERSION!.replace(/\./gu, "\\.")));
  assert.match(outdated, /project/);
  assert.ok(!frame.includes("portable/fresh"), "up-to-date items are not listed");
  assert.ok(!frame.includes("portable/mystery"), "unassessable items are folded");
  assert.match(frame, /2 up to date/);
  assert.match(frame, /1 cannot be checked ▸/);
  assert.ok(!frame.includes("no trustworthy resolved version evidence"), "reasons show only when expanded");
  unmount();
});

test("Enter on the cannot-be-checked line lists each item with its reason, and left collapses it", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "outdated", state: "outdated" },
    { name: "mystery", state: "unknown" },
    { name: "enigma", state: "unknown" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /2 cannot be checked ▸/);
  press(stdin, "j");
  await waitForFrame(lastFrame, (frame) => /> .*cannot be checked/.test(frame));
  press(stdin, ENTER);
  const open = await waitForFrame(lastFrame, /2 cannot be checked ▾/);
  assert.match(open, /portable\/mystery/);
  assert.match(open, /portable\/enigma/);
  assert.match(open, /no trustworthy resolved version evidence/);
  press(stdin, "\u001B[D");
  await waitForFrame(lastFrame, (frame) => /cannot be checked ▸/.test(frame) && !frame.includes("portable/mystery"));
  press(stdin, "\u001B[C");
  await waitForFrame(lastFrame, /portable\/mystery/);
  unmount();
});

test("never offers a built-in Skill installed by a newer Agent Depot and says why", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "outdated", state: "outdated" },
    { name: "ahead", state: "newer" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /portable\/outdated/);
  assert.ok(!frame.includes("portable/ahead"), "the newer-installed Skill is not offered");
  assert.match(frame, /1 cannot be checked ▸ \(1 installed by a newer Agent Depot\)/);
  press(stdin, "j");
  await waitForFrame(lastFrame, (current) => /> .*cannot be checked/.test(current));
  press(stdin, ENTER);
  const open = await waitForFrame(lastFrame, /portable\/ahead/);
  assert.match(open, /Installed by a newer Agent Depot \(999\.0\.0\)/);
  assert.match(open, /update Agent Depot/);
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
  await waitForFrame(failing.lastFrame, /Error \(project\): manifest exploded/);
  failing.unmount();
});

test("the scope filter defaults to all and t, p and g switch it without checking again", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "projonly", state: "outdated" }]);
  await seedGlobal(f, { name: "globalonly", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  const all = await waitForFrame(lastFrame, (frame) => frame.includes("portable/projonly") && frame.includes("portable/globalonly"));
  assert.match(all, /scope: all/);
  assert.match(all.split("\n").find((line) => line.includes("portable/globalonly")) ?? "", /user-global/);
  const reads = f.readCalls.length;
  press(stdin, "g");
  const global = await waitForFrame(lastFrame, /scope: user-global/);
  assert.match(global, /portable\/globalonly/);
  assert.ok(!global.includes("portable/projonly"));
  press(stdin, "p");
  const project = await waitForFrame(lastFrame, /scope: project/);
  assert.match(project, /portable\/projonly/);
  assert.ok(!project.includes("portable/globalonly"));
  press(stdin, "t");
  await waitForFrame(lastFrame, (frame) => /scope: all/.test(frame) && frame.includes("portable/globalonly") && frame.includes("portable/projonly"));
  assert.equal(f.readCalls.length, reads, "changing the filter does not assess again");
  unmount();
});

test("a pasted prototype property name never changes the scope filter", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "projonly", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/projonly/);
  press(stdin, "constructor");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(lastFrame() ?? "", /scope: all/);
  press(stdin, "p");
  const frame = await waitForFrame(lastFrame, /scope: project/);
  assert.match(frame, /portable\/projonly/);
  unmount();
});

test("changing the scope filter drops selected items so nothing hidden is applied", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "projonly", state: "outdated" }]);
  await seedGlobal(f, { name: "globalonly", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /2 updates|portable\/globalonly/);
  press(stdin, "a");
  await waitForFrame(lastFrame, /2 selected/);
  press(stdin, "g");
  await waitForFrame(lastFrame, /scope: user-global/);
  await waitForFrame(lastFrame, /0 selected/);
  unmount();
});

test("refreshes the Git sources involved before the assessment, showing a busy state and then when it checked", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "ext", state: "outdated", url: GIT_URL },
    { name: "builtin", state: "outdated" },
  ]);
  let release!: () => void;
  f.gate.promise = new Promise<void>((resolve) => { release = resolve; });
  const { lastFrame, unmount } = mount(f);
  await waitForFrame(lastFrame, /Refreshing sources/);
  assert.deepEqual(f.readCalls, [], "nothing is assessed while sources refresh");
  release();
  const frame = await waitForFrame(lastFrame, /portable\/ext/);
  assert.match(frame, /checked just now · sources refreshed/);
  assert.deepEqual(f.events.filter((event) => event.startsWith("refresh:")), [`refresh:${GIT_URL}`], "the built-in source is skipped");
  assert.ok(f.events.indexOf(`refresh:${GIT_URL}`) < f.events.findIndex((event) => event.startsWith("read:")), "refresh precedes the assessment");
  unmount();
});

test("refreshes each distinct Git source once even when installed in both scopes", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", url: GIT_URL }]);
  await seedGlobal(f, { name: "two", state: "outdated", url: GIT_URL });
  const { lastFrame, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/two/);
  assert.deepEqual(f.events.filter((event) => event.startsWith("refresh:")), [`refresh:${GIT_URL}`]);
  unmount();
});

test("r refreshes the sources again and rechecks", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "ext", state: "outdated", url: GIT_URL }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/ext/);
  const refreshes = () => f.events.filter((event) => event.startsWith("refresh:")).length;
  const reads = f.readCalls.length;
  assert.equal(refreshes(), 1);
  press(stdin, "r");
  await waitForFrame(lastFrame, () => refreshes() === 2 && f.readCalls.length > reads);
  await waitForFrame(lastFrame, /portable\/ext/);
  unmount();
});

test("a failed refresh is reported per source and the check still runs on the current data", async (t) => {
  const f = await fixture(t);
  const other = "https://example.com/other.git";
  await seedProject(f, [
    { name: "broken", state: "outdated", url: GIT_URL },
    { name: "fine", state: "outdated", url: other },
  ]);
  f.failRefresh.add(GIT_URL);
  const { lastFrame, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /portable\/fine/);
  assert.match(frame, /portable\/broken/, "the check still ran for the source that failed to refresh");
  assert.match(frame, new RegExp(`${GIT_URL.replace(/\./gu, "\\.")}.*network unreachable`));
  assert.match(frame, /1 of 2 sources could not be refreshed; their current data was used/);
  assert.ok(!frame.includes("sources refreshed"), "does not claim a full refresh");
  unmount();
});

test("says so when there is no Git source to refresh", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "builtin", state: "outdated" }]);
  const { lastFrame, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /portable\/builtin/);
  assert.match(frame, /checked just now · no Git sources to refresh/);
  assert.deepEqual(f.events.filter((event) => event.startsWith("refresh:")), []);
  unmount();
});

test("formats the age of the check", () => {
  assert.equal(formatAgo(0), "just now");
  assert.equal(formatAgo(4_000), "just now");
  assert.equal(formatAgo(42_000), "42s ago");
  assert.equal(formatAgo(60_000), "1 min ago");
  assert.equal(formatAgo(5 * 60_000 + 30_000), "5 min ago");
  assert.equal(formatAgo(2 * 3_600_000), "2 h ago");
});

test("the age of the check follows the clock", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  let now = 1_000_000;
  const { lastFrame, stdin, unmount } = mount(f, { now: () => now });
  await waitForFrame(lastFrame, /checked just now/);
  now += 5 * 60_000;
  // Any change of view state redraws the line; here the scope filter.
  press(stdin, "p");
  await waitForFrame(lastFrame, /checked 5 min ago/);
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
  press(stdin, "a");
  const frame = await waitForFrame(lastFrame, /2 selected/);
  assert.equal(frame.split("\n").filter((line) => line.includes("[x]")).length, 2);
  press(stdin, " ");
  await waitForFrame(lastFrame, /1 selected/);
  unmount();
});

test("previews the update, writes nothing before y, then reports and reloads without refreshing again", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", url: GIT_URL }]);
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
  await waitForFrame(lastFrame, (frame) => /1 up to date/.test(frame) && !/update available|\[ \]/.test(frame));
  assert.equal(f.events.filter((event) => event.startsWith("refresh:")).length, 1, "reloading after apply does not fetch the sources again");
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

test("one preview and confirmation applies project and user-global updates together", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "proj", state: "outdated" }]);
  await seedGlobal(f, { name: "glob", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, (frame) => frame.includes("portable/proj") && frame.includes("portable/glob"));
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /Apply 2 updates\? y\/n/);
  assert.match(preview, /Preview: update Skill "portable\/proj" from builtin:agent-depot \(scope: project\)/);
  assert.match(preview, /Preview: update Skill "portable\/glob" from builtin:agent-depot \(scope: user-global\)/);
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /2 updated, 0 failed/);
  assert.match(done, /Updated portable\/proj/);
  assert.match(done, /Updated portable\/glob/);
  assert.equal(await f.read(f.project, ".agents/skills/proj"), newText("proj"));
  assert.equal(await f.read(f.home, ".agents/skills/glob"), newText("glob"));
  unmount();
});

test("the same Skill installed in both scopes is two separate selectable items", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "twin", state: "outdated" }]);
  await seedGlobal(f, { name: "twin", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, (frame) => frame.split("\n").filter((line) => line.includes("portable/twin")).length === 2);
  press(stdin, " ");
  const frame = await waitForFrame(lastFrame, /1 selected/);
  assert.equal(frame.split("\n").filter((line) => line.includes("[x]")).length, 1);
  unmount();
});

test("reports capturing while refreshing and previewing, and not while browsing", async (t) => {
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

test("the footer names the scope keys and the check", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /4 Updates/);
  press(stdin, "4");
  // While the sources refresh the view captures keys, so the footer shows the check key once it is done.
  const frame = await waitForFrame(lastFrame, /r check again/);
  assert.match(frame, /t all/);
  assert.match(frame, /p project/);
  assert.match(frame, /g user-global/);
  assert.match(frame, /r check again/);
  unmount();
});

test("windows a long list of updates around the highlight and pages with PgDn", async (t) => {
  const f = await fixture(t);
  const specs = Array.from({ length: 12 }, (_, n): SkillSpec => ({ name: `skill${String(n).padStart(2, "0")}`, state: "outdated" }));
  await seedProject(f, specs);
  const { lastFrame, stdin, unmount } = render(
    <UpdatesView operations={f.operations} environment={f.environment} listHeight={4} />,
  );
  const top = await waitForFrame(lastFrame, /1–4 of 12/);
  assert.equal(top.split("\n").filter((line) => /skill\d\d/.test(line)).length, 4);
  press(stdin, "\u001B[6~");
  const paged = await waitForFrame(lastFrame, (frame) => /> .*skill04/.test(frame));
  assert.match(paged, /\d+–\d+ of 12/);
  assert.ok(!paged.includes("skill00"));
  unmount();
});

test("a refresh phase that cannot read the installations says so instead of claiming there was nothing to refresh", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", url: GIT_URL }]);
  let loads = 0;
  const flaky = {
    load: async () => {
      loads += 1;
      // The first read is the refresh phase's; the assessment that follows succeeds.
      if (loads === 1) throw new Error("manifest busy");
      return f.manifestStore.load();
    },
  } as unknown as ProjectManifestStore;
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, projectManifestStore: flaky }} />);
  const frame = await waitForFrame(view.lastFrame, /portable\/one/);
  assert.match(frame, /could not refresh: manifest busy/);
  assert.ok(!frame.includes("no Git sources to refresh"), "a failed read is not an empty refresh");
  assert.deepEqual(f.events.filter((event) => event.startsWith("refresh:")), [], "nothing was fetched");
  view.unmount();
});

test("a non-canonical path is confirmed per scope and path: the other scope's confirmation of the same string does not count", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", installPath: "tools/skills/one" }]);
  const data = await loadUpdateRows(f.operations, f.environment, { refresh: false });
  const prepared = await prepareUpdates(data, data.rows);
  assert.deepEqual(prepared.nonCanonicalPaths, [{ scope: "project", path: "tools/skills/one" }]);

  const wrongScope = await runUpdates(prepared, [{ scope: "user-global", path: "tools/skills/one" }]);
  assert.equal(wrongScope.failed, 1, "the same path string in another scope is not a confirmation");
  assert.equal(await f.read(f.project, "tools/skills/one"), oldText("one"));

  const confirmed = await runUpdates(prepared, [{ scope: "project", path: "tools/skills/one" }]);
  assert.equal(confirmed.failed, 0);
  assert.equal(await f.read(f.project, "tools/skills/one"), newText("one"));
});

test("the confirm-paths panel labels each path with its scope", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", installPath: "tools/skills/one" }]);
  await seedGlobal(f, { name: "two", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, (frame) => frame.includes("portable/one") && frame.includes("portable/two"));
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "y");
  const panel = await waitForFrame(lastFrame, /Confirm replacing non-canonical/);
  assert.match(panel, /\[project\] "tools\/skills\/one"/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /2 updated, 0 failed/);
  assert.equal(await f.read(f.project, "tools/skills/one"), newText("one"));
  assert.equal(await f.read(f.home, ".agents/skills/two"), newText("two"));
  unmount();
});

test("a Skill that became locally modified after the preview is not overwritten", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }, { name: "two", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /Apply 2 updates\? y\/n/);
  assert.ok(!preview.includes("local modifications"), "the preview showed no overwrite");
  await writeFile(path.join(f.project, ".agents/skills/one/SKILL.md"), "edited after the preview", "utf8");
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /1 updated, 1 failed/);
  assert.match(done, /Failed portable\/one:[\s\S]*modified after the\s+preview/);
  assert.equal(await f.read(f.project, ".agents/skills/one"), "edited after the preview", "the new local edit survives");
  assert.equal(await f.read(f.project, ".agents/skills/two"), newText("two"));
  unmount();
});

test("an item whose preview failed is excluded from the apply and its files stay untouched", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "good", state: "outdated" }, { name: "bad", state: "outdated" }]);
  const operations: SourceOperations = {
    ...f.operations,
    async readInstallationMethod(_source, skillPath) {
      if (skillPath === "portable/bad") throw new Error("cannot read install metadata");
      return undefined;
    },
  };
  const { lastFrame, stdin, unmount } = render(<UpdatesView operations={operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /portable\/bad/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /Apply 1 update\? y\/n/);
  assert.match(preview, /Preview failed for[\s\S]*bad[\s\S]*cannot read install metadata/);
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /1 updated, 1 failed/);
  assert.match(done, /Failed portable\/bad: preview failed: cannot read install metadata/);
  assert.equal(await f.read(f.project, ".agents/skills/good"), newText("good"));
  assert.equal(await f.read(f.project, ".agents/skills/bad"), oldText("bad"));
  unmount();
});

test("with a scope filter active, y applies only the visible items and leaves the hidden ones' files untouched", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "proj", state: "outdated" }]);
  await seedGlobal(f, { name: "glob", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, (frame) => frame.includes("portable/proj") && frame.includes("portable/glob"));
  press(stdin, "g");
  await waitForFrame(lastFrame, (frame) => /scope: user-global/.test(frame) && !frame.includes("portable/proj"));
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Apply 1 update\? y\/n/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /1 updated, 0 failed/);
  assert.equal(await f.read(f.home, ".agents/skills/glob"), newText("glob"));
  assert.equal(await f.read(f.project, ".agents/skills/proj"), oldText("proj"), "the hidden project item was not applied");
  unmount();
});

test("after a failed refresh the apply works on the current data and the view said the data was not fresh", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "ext", state: "outdated", url: GIT_URL }]);
  f.failRefresh.add(GIT_URL);
  const { lastFrame, stdin, unmount } = mount(f);
  const listed = await waitForFrame(lastFrame, /portable\/ext/);
  assert.match(listed, /1 of 1 sources could not be refreshed; their current data was used/);
  assert.match(listed, /network unreachable/);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Apply 1 update\? y\/n/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /1 updated, 0 failed/);
  assert.equal(await f.read(f.project, ".agents/skills/ext"), newText("ext"));
  unmount();
});

test("keys sent in one burst move and select against the latest state", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "three", state: "outdated" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/three/);
  for (const data of ["j", "j", " "]) press(stdin, data);
  const frame = await waitForFrame(lastFrame, /1 selected/);
  const line = (name: string) => frame.split("\n").find((candidate) => candidate.includes(`portable/${name}`)) ?? "";
  assert.match(line("three"), /\[x\]/);
  assert.match(line("one"), /\[ \]/);
  assert.match(line("three"), /^> /);
  unmount();
});

test("j, j, space, Enter in one burst previews the item the highlight reached", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "three", state: "outdated" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/three/);
  for (const data of ["j", "j", " ", ENTER]) press(stdin, data);
  const frame = await waitForFrame(lastFrame, /Apply 1 update\? y\/n/);
  assert.match(frame, /three/);
  unmount();
});

test("a scope key followed by navigation in one burst acts on the filtered list", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
  ]);
  await seedGlobal(f, { name: "glob", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/glob/);
  for (const data of ["p", "j", " "]) press(stdin, data);
  const frame = await waitForFrame(lastFrame, /1 selected/);
  const line = (name: string) => frame.split("\n").find((candidate) => candidate.includes(`portable/${name}`)) ?? "";
  assert.match(line("two"), /\[x\]/);
  assert.match(line("one"), /\[ \]/);
  assert.ok(!frame.includes("portable/glob"));
  unmount();
});

test("the right arrow and j in one burst move within the expanded cannot-be-checked lines", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "mystery", state: "unknown" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /1 cannot be checked/);
  for (const data of ["j", "\u001B[C", "j"]) press(stdin, data);
  const frame = await waitForFrame(lastFrame, (candidate) => /^> .*portable\/mystery/m.test(candidate));
  assert.match(frame, /1 cannot be checked ▾/);
  unmount();
});

test("several keys delivered in a single write are handled one by one", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "three", state: "outdated" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /portable\/three/);
  press(stdin, "jj ");
  const frame = await waitForFrame(lastFrame, /1 selected/);
  assert.match(frame.split("\n").find((line) => line.includes("portable/three")) ?? "", /\[x\]/);
  unmount();
});
