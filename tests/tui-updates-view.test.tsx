import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";
import { createAppOperations } from "../src/app-flow.js";

import {
  AGENT_DEPOT_PACKAGE_VERSION,
  defaultProjectManifestPath,
  parseProjectManifest,
  ProjectManifestStore,
  type ProjectSkillSelection,
} from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import type { BundleDescriptor, InstalledPackage, PackageLifecyclePlan, PackageSelection } from "../src/package-model.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { createSourceRefreshSession, withRefreshSession } from "../src/source-refresh-session.js";
import { formatAgo, loadUpdateRows, prepareUpdates, runUpdates } from "../src/tui/updates.js";
import { App } from "../src/tui/app.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { UpdatesView } from "../src/tui/updates-view.js";
import { fakePackageOperations } from "./fake-package-operations.js";
import { expandList } from "./expand-updates.js";
import { squash, waitForFrame, waitForSettled } from "./wait-for-frame.js";
import { deferCleanup } from "./test-cleanup.js";
import { confirmAtEnd, PREVIEW_SIZES, resizeTerminal } from "./preview-footer.js";

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
  /** Holds the assessment, after the Sources were refreshed. */
  readonly readGate: { promise?: Promise<void> };
  read(root: string, installPath: string): Promise<string>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-upd-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-upd-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-upd-state-"));
  deferCleanup(t, async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const readCalls: string[] = [];
  const events: string[] = [];
  const methodCalls: string[] = [];
  const failMethodFor = new Set<string>();
  const failRefresh = new Set<string>();
  const gate: { promise?: Promise<void> } = {};
  const readGate: { promise?: Promise<void> } = {};
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
      if (readGate.promise) await readGate.promise;
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
    readGate,
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
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";


async function reviewToEnd(lastFrame: () => string | undefined, stdin: Stdin, question: RegExp): Promise<string> {
  await waitForFrame(lastFrame, /Update batch preview/);
  const visited: string[] = [];
  for (let page = 0; page < 100; page += 1) {
    const frame = lastFrame() ?? "";
    visited.push(frame);
    if (question.test(frame)) return visited.join("\n");
    const review = /Review (\d+) of (\d+)/u.exec(frame);
    assert.ok(review, `preview lost its review position:\n${frame}`);
    const before = Number(review[1]);
    press(stdin, "\u001B[6~");
    await waitForFrame(lastFrame, (next) => question.test(next) || Number(/Review (\d+) of (\d+)/u.exec(next)?.[1] ?? before) > before);
  }
  assert.fail(`preview did not expose its final confirmation:\n${lastFrame()}`);
}

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
  const { lastFrame, stdin, unmount } = mount(f);
  assert.match(lastFrame() ?? "", /Refreshing sources|Checking for updates/);
  const frame = await expandList(lastFrame, stdin, /portable\/outdated/, 3);
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
  await expandList(lastFrame, stdin, /portable\/mystery/);
  unmount();
});

test("never offers a built-in Skill installed by a newer Agent Depot and says why", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "outdated", state: "outdated" },
    { name: "ahead", state: "newer" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  const frame = await expandList(lastFrame, stdin, /portable\/outdated/, 3);
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
  const all = await expandList(lastFrame, stdin, /portable\/globalonly/);
  assert.match(all, /scope: all/);
  assert.match(all, /portable\/projonly/);
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
  await expandList(lastFrame, stdin, /portable\/projonly/);
  // The pasted letters are split into keys, and its "r" starts a re-check;
  // wait until that check has finished before changing the scope.
  press(stdin, "constructor");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await waitForFrame(lastFrame, (frame) =>
    /scope: all/.test(frame) && /checked/.test(frame) && !/Refreshing|Checking/.test(frame));
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
  await waitForFrame(lastFrame, /▸ builtin:agent-depot \(2\)/);
  press(stdin, "a");
  await waitForFrame(lastFrame, /2 selected/);
  press(stdin, "g");
  await waitForFrame(lastFrame, /scope: user-global/);
  await waitForFrame(lastFrame, /0 selected/);
  unmount();
});

test("the elapsed time of a check keeps running when it moves from refreshing to checking", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "ext", state: "outdated", url: GIT_URL }]);
  let releaseRefresh!: () => void;
  let releaseRead!: () => void;
  f.gate.promise = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  f.readGate.promise = new Promise<void>((resolve) => { releaseRead = resolve; });
  // The elapsed time only shows while animating, which the test environment turns off.
  const previous = process.env.AGENT_DEPOT_NO_ANIMATION;
  process.env.AGENT_DEPOT_NO_ANIMATION = "0";
  deferCleanup(t, () => {
    if (previous === undefined) delete process.env.AGENT_DEPOT_NO_ANIMATION;
    else process.env.AGENT_DEPOT_NO_ANIMATION = previous;
  });
  // A clock unrelated to the wall clock: the check must start and read its elapsed time on the injected one.
  const base = 1_000_000;
  let clock = base;
  const { lastFrame, stdin, unmount } = mount(f, { now: () => clock });
  deferCleanup(t, unmount);
  await waitForFrame(lastFrame, /Refreshing sources…/);
  clock = base + 4500;
  await waitForFrame(lastFrame, /Refreshing sources… 4s/);
  releaseRefresh();
  const checking = await waitForFrame(lastFrame, /Checking for updates… 4s/);
  assert.equal(checking.match(/Checking for updates…/g)?.length, 1, "one indicator for the whole check");
  releaseRead();
  await expandList(lastFrame, stdin, /portable\/ext/);
});

test("refreshes the Git sources involved before the assessment, showing a busy state and then when it checked", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "ext", state: "outdated", url: GIT_URL },
    { name: "builtin", state: "outdated" },
  ]);
  let release!: () => void;
  f.gate.promise = new Promise<void>((resolve) => { release = resolve; });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /Refreshing sources/);
  assert.deepEqual(f.readCalls, [], "nothing is assessed while sources refresh");
  release();
  const frame = await expandList(lastFrame, stdin, /portable\/ext/);
  assert.match(frame, /checked just now · sources refreshed/);
  assert.deepEqual(f.events.filter((event) => event.startsWith("refresh:")), [`refresh:${GIT_URL}`], "the built-in source is skipped");
  assert.ok(f.events.indexOf(`refresh:${GIT_URL}`) < f.events.findIndex((event) => event.startsWith("read:")), "refresh precedes the assessment");
  unmount();
});

test("with a refresh session, reopening Updates reuses the recent refresh and says when it was made, while r refreshes again", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "ext", state: "outdated", url: GIT_URL }]);
  let clock = Date.now();
  const now = () => clock;
  const session = createSourceRefreshSession(f.operations, { now });
  const operations = withRefreshSession(f.operations, session);
  const environment = { ...f.environment, refreshSession: session };
  const refreshes = () => f.events.filter((event) => event.startsWith("refresh:")).length;

  const first = render(<UpdatesView operations={operations} environment={environment} now={now} />);
  const opened = await expandList(first.lastFrame, first.stdin, /portable\/ext/);
  assert.match(opened, /sources refreshed\s*│/);
  assert.equal(refreshes(), 1);
  first.unmount();

  clock += 3 * 60_000;
  const second = render(<UpdatesView operations={operations} environment={environment} now={now} />);
  const reopened = await expandList(second.lastFrame, second.stdin, /portable\/ext/);
  assert.match(reopened, /sources refreshed 3 min ago/);
  assert.equal(refreshes(), 1, "entering Updates again within the hour reuses the refresh");

  second.stdin.write("r");
  await waitForFrame(second.lastFrame, () => refreshes() === 2);
  const rechecked = await expandList(second.lastFrame, second.stdin, /portable\/ext/);
  assert.match(rechecked, /sources refreshed\s*│/);
  second.unmount();
});

test("refreshes each distinct Git source once even when installed in both scopes", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", url: GIT_URL }]);
  await seedGlobal(f, { name: "two", state: "outdated", url: GIT_URL });
  const { lastFrame, stdin, unmount } = mount(f);
  await expandList(lastFrame, stdin, /portable\/two/);
  assert.deepEqual(f.events.filter((event) => event.startsWith("refresh:")), [`refresh:${GIT_URL}`]);
  unmount();
});

test("u previews the selected batch and n cancels without running an update", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "outdated", state: "outdated", method: ["update-fixture"] }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await expandList(lastFrame, stdin, /portable\/outdated/);
  press(stdin, " ");
  await waitForFrame(lastFrame, /1 selected/);
  press(stdin, "u");
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
  assert.match(preview, /Update batch preview/);
  assert.deepEqual(f.methodCalls, [], "preview does not execute the installation method");
  press(stdin, "n");
  await waitForFrame(lastFrame, /Update cancelled/);
  assert.deepEqual(f.methodCalls, [], "cancelling keeps the installation method unexecuted");
  unmount();
});

test("r refreshes the sources again and rechecks", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "ext", state: "outdated", url: GIT_URL }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await expandList(lastFrame, stdin, /portable\/ext/);
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
  const { lastFrame, stdin, unmount } = mount(f);
  const frame = await expandList(lastFrame, stdin, /portable\/fine/);
  assert.match(frame, /portable\/broken/, "the check still ran for the source that failed to refresh");
  assert.match(frame, new RegExp(`${GIT_URL.replace(/\./gu, "\\.")}.*network unreachable`));
  assert.match(frame, /1 of 2 sources could not be refreshed; their current data was used/);
  assert.ok(!frame.includes("sources refreshed"), "does not claim a full refresh");
  unmount();
});

test("says so when there is no Git source to refresh", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "builtin", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  const frame = await expandList(lastFrame, stdin, /portable\/builtin/);
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
  await expandList(lastFrame, stdin, /portable\/one/);
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /Select at least one/);
  press(stdin, " ");
  await waitForFrame(lastFrame, /1 selected/);
  press(stdin, "a");
  const frame = await waitForFrame(lastFrame, /2 selected/);
  assert.equal(frame.split("\n").filter((line) => line.includes("portable/") && line.includes("[x]")).length, 2);
  press(stdin, " ");
  await waitForFrame(lastFrame, /1 selected/);
  unmount();
});

test("previews the update, writes nothing before y, then reports and reloads without refreshing again", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", url: GIT_URL }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await expandList(lastFrame, stdin, /portable\/one/);
  const checkReads = f.readCalls.length;
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
  assert.equal(f.readCalls.length, checkReads, "the preview reuses the assessed snapshot instead of rereading or refreshing the Source");
  assert.match(preview, /SKILLS\s+│\n│ {2}portable\/one {2}/);
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
  await expandList(lastFrame, stdin, /portable\/one/);
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
  await expandList(lastFrame, stdin, /portable\/one/);
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
  await expandList(lastFrame, stdin, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  // A long preview (long Windows paths wrap) needs paging to the end before y is accepted.
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
  assert.match(preview, /\$ node --fake-update/);
  assert.match(preview, /^│ {4}in \S/mu);
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
  await expandList(lastFrame, stdin, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
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
  await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
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
  await expandList(lastFrame, stdin, /portable\/bad/);
  press(stdin, "a");
  press(stdin, ENTER);
  await reviewToEnd(lastFrame, stdin, /Apply 2 updates\?/);
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
  await expandList(lastFrame, stdin, /portable\/glob/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 2 updates\?/);
  assert.match(preview, /portable\/proj {2}builtin:agent-depot · project/);
  assert.match(preview, /portable\/glob {2}builtin:agent-depot · user-global/);
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /2 updated, 0 failed/);
  assert.match(done, /Updated portable\/proj/);
  assert.match(done, /Updated portable\/glob/);
  assert.equal(await f.read(f.project, ".agents/skills/proj"), newText("proj"));
  assert.equal(await f.read(f.home, ".agents/skills/glob"), newText("glob"));
  unmount();
});

test("reports each Skill, App and Package as it starts, numbered across the whole batch and across a manual pause", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "proj", state: "outdated" }]);
  await seedGlobal(f, { name: "glob", state: "outdated" });
  const data = await loadUpdateRows(f.operations, f.environment, { refresh: false });
  const skills = await prepareUpdates(data, data.rows);
  const events: string[] = [];
  const apps = {
    async executeLifecycle() { return { status: "manual required", reason: "do it yourself" }; },
    async completeManual() { return { status: "failed", reason: "still old" }; },
  };
  const packages = {
    async executeLifecycle() { return { status: "failed", reason: "host refused" }; },
  };
  const prepared = {
    ...skills,
    apps: apps as unknown as NonNullable<typeof skills.apps>,
    appPlans: [{ entry: { recipe: { name: "demo" } } }] as unknown as typeof skills.appPlans,
    packages: packages as unknown as NonNullable<typeof skills.packages>,
    packagePlans: [{ plan: { descriptor: { name: "pkg" }, selection: packageSelection }, approval: "approved" }] as unknown as NonNullable<typeof skills.packagePlans>,
  };
  const confirmManual = async () => { events.push("manual pause"); return true; };
  const onProgress = (event: { readonly kind: string; readonly name: string; readonly position: number; readonly total: number }) => {
    events.push(`${event.kind} ${event.name} ${event.position}/${event.total}`);
  };
  const outcome = await runUpdates(prepared, [], confirmManual, onProgress);
  assert.equal(outcome.failed, 2);
  assert.deepEqual(events, [
    "skill portable/proj 1/4",
    "skill portable/glob 2/4",
    "app demo 3/4",
    "manual pause",
    "package pkg 4/4",
  ]);
});

test("the busy line names the item being updated and the clock keeps running from item to item", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated", method: ["node", "--fake-update"] },
    { name: "two", state: "outdated", method: ["node", "--fake-update"] },
  ]);
  const releases: (() => void)[] = [];
  const execute = f.operations.executeInstallationMethod!;
  f.operations.executeInstallationMethod = async (method, context) => {
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return execute(method, context);
  };
  // The elapsed time only shows while animating, which the test environment turns off.
  const previous = process.env.AGENT_DEPOT_NO_ANIMATION;
  process.env.AGENT_DEPOT_NO_ANIMATION = "0";
  deferCleanup(t, () => {
    if (previous === undefined) delete process.env.AGENT_DEPOT_NO_ANIMATION;
    else process.env.AGENT_DEPOT_NO_ANIMATION = previous;
  });
  let clock = 1_000_000;
  const { lastFrame, stdin, unmount } = mount(f, { now: () => clock });
  deferCleanup(t, unmount);
  await expandList(lastFrame, stdin, /portable\/two/);
  press(stdin, "a");
  press(stdin, ENTER);
  await reviewToEnd(lastFrame, stdin, /Apply 2 updates\?/);
  press(stdin, "y");
  await waitForFrame(lastFrame, /Updating Skill portable\/one \(1\/2\)…/);
  clock += 4500;
  await waitForFrame(lastFrame, /Updating Skill portable\/one \(1\/2\)… 4s/);
  // The label is set before the item reaches its method, so wait for the method to be held.
  await waitForFrame(lastFrame, () => releases.length === 1);
  releases.shift()!();
  await waitForFrame(lastFrame, /Updating Skill portable\/two \(2\/2\)… 4s/);
  await waitForFrame(lastFrame, () => releases.length === 1);
  releases.shift()!();
  await waitForFrame(lastFrame, /2 updated, 0 failed/);
});

test("the same Skill installed in both scopes is two separate selectable items", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "twin", state: "outdated" }]);
  await seedGlobal(f, { name: "twin", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await expandList(lastFrame, stdin, /portable\/twin/);
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
  await expandList(lastFrame, stdin, /portable\/one/);
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
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  press(stdin, "4");
  await waitForFrame(lastFrame, /▶ \[4\] Updates/);
  await expandList(lastFrame, stdin, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  press(stdin, "q");
  press(stdin, "1");
  const frame = await waitForFrame(lastFrame, /Apply 1 update/);
  assert.match(frame, /▶ \[4\] Updates/);
  assert.equal(exited, false);
  press(stdin, "n");
  await waitForFrame(lastFrame, /Update cancelled/);
  press(stdin, "1");
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
  // Sources reads state under the fixture as it mounts; wait for it so teardown cannot race the read.
  await waitForSettled(lastFrame);
  unmount();
});

test("the footer names the scope keys and the check", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = render(<App operations={f.operations} environment={f.environment} />);
  await waitForFrame(lastFrame, /▶ \[1\] Sources/);
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
  await waitForFrame(lastFrame, /1–4 of 14|▸ builtin:agent-depot \(12\)/);
  expandAll(stdin);
  const top = await waitForFrame(lastFrame, /1–4 of 14/);
  assert.equal(top.split("\n").filter((line) => /skill\d\d/.test(line)).length, 2, "the two group headers use two of the four lines");
  press(stdin, "\u001B[6~");
  const paged = await waitForFrame(lastFrame, (frame) => /> .*skill02/.test(frame));
  assert.match(paged, /\d+–\d+ of 14/);
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
  const frame = await expandList(view.lastFrame, view.stdin, /portable\/one/);
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

test("the project-scope update preview starts with the project root and the user-global one does not", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  await seedGlobal(f, { name: "two", state: "outdated" });
  const data = await loadUpdateRows(f.operations, f.environment, { refresh: false });
  const documentOf = async (scope: "project" | "user-global") =>
    (await prepareUpdates(data, data.rows.filter((row) => row.kind !== "app" && row.kind !== "package" && row.scope === scope))).document;
  const project = await documentOf("project");
  assert.deepEqual(project.context, [`Project: ${f.project}`]);
  assert.equal(project.sections[0]?.items[0]?.title, "portable/one");
  assert.deepEqual((await documentOf("user-global")).context, []);
});

test("the confirm-paths panel labels each path with its scope", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", installPath: "tools/skills/one" }]);
  await seedGlobal(f, { name: "two", state: "outdated" });
  const { lastFrame, stdin, unmount } = mount(f);
  await expandList(lastFrame, stdin, /portable\/two/);
  press(stdin, "a");
  press(stdin, ENTER);
  await reviewToEnd(lastFrame, stdin, /y\/n/);
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
  await expandList(lastFrame, stdin, /portable\/one/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 2 updates\?/);
  assert.ok(!preview.includes("local modifications"), "the preview showed no overwrite");
  await writeFile(path.join(f.project, ".agents/skills/one/SKILL.md"), "edited after the preview", "utf8");
  press(stdin, "y");
  const done = await waitForFrame(lastFrame, /1 updated, 1 failed/);
  const unwrapped = done.replace(/[│╭╮╰╯]/gu, " ").replace(/\s+/gu, " ");
  assert.match(unwrapped, /Failed portable\/one:.*modified after the preview/);
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
  await expandList(lastFrame, stdin, /portable\/bad/);
  press(stdin, "a");
  press(stdin, ENTER);
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
  assert.match(preview, /FAILED\s+│\n│ {2}portable\/bad:/);
  assert.match(preview.replace(/[\s│]/gu, ""), /cannotreadinstallmetadata/);
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
  await expandList(lastFrame, stdin, /portable\/glob/);
  press(stdin, "g");
  await waitForFrame(lastFrame, (frame) => /scope: user-global/.test(frame) && !frame.includes("portable/proj"));
  press(stdin, "a");
  // Enter on a group expands it, so the preview starts with u.
  press(stdin, "u");
  await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
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
  const listed = await expandList(lastFrame, stdin, /portable\/ext/);
  assert.match(listed, /1 of 1 sources could not be refreshed; their current data was used/);
  assert.match(listed, /network unreachable/);
  press(stdin, "a");
  press(stdin, ENTER);
  await reviewToEnd(lastFrame, stdin, /Apply 1 update\?/);
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
  await expandList(lastFrame, stdin, /portable\/three/);
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
  await expandList(lastFrame, stdin, /portable\/three/);
  for (const data of ["j", "j", " ", ENTER]) press(stdin, data);
  const frame = await waitForFrame(lastFrame, /Update batch preview/);
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
  await expandList(lastFrame, stdin, /portable\/glob/);
  for (const data of ["p", "j", "j", "j", " "]) press(stdin, data);
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
  await expandList(lastFrame, stdin, /portable\/three/);
  press(stdin, "jj ");
  const frame = await waitForFrame(lastFrame, /1 selected/);
  assert.match(frame.split("\n").find((line) => line.includes("portable/three")) ?? "", /\[x\]/);
  unmount();
});

test("mixed Skills and Apps continue after App failure with a combined summary", async t => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  const recipesDirectory = path.join(f.home, "apps");
  await mkdir(recipesDirectory);
  for (const name of ["bad", "good"]) {
    await writeFile(path.join(recipesDirectory, `${name}.json`), JSON.stringify({
      name, install: { manual: "install" }, uninstall: { manual: "remove" }, update: { argv: [name, "update"] },
      version: { argv: [name, "version"], pattern: "(\\S+)" }, latest: { npm: name },
    }));
  }
  let updated = false;
  let lookups = 0;
  const appEnvironment = { recipesDirectory, homeDirectory: f.home,
    resolveExecutable: async (name: string) => `/usr/bin/${name}`,
    fetch: async () => { lookups++; return new Response(JSON.stringify({ "dist-tags": { latest: "2.0.0" } })); },
    runner: async (exe: string, args: readonly string[]) => {
      if (args[0] === "update" && exe.endsWith("good")) updated = true;
      return { code: args[0] === "update" && exe.endsWith("bad") ? 1 : 0, signal: null,
        stdout: Buffer.from(updated && exe.endsWith("good") ? "2.0.0" : "1.0.0"), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  for (const entry of await apps.load()) await apps.approve(entry);
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, appEnvironment }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  await expandList(view.lastFrame, view.stdin, frame => frame.includes("App: good") && frame.includes("portable/one"));
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /3 selected/);
  view.stdin.write(ENTER);
  await reviewToEnd(view.lastFrame, view.stdin, /Apply 3 updates\?/);
  assert.equal(lookups, 2);
  view.stdin.write("y");
  const frame = await waitForFrame(view.lastFrame, /Update summary: 2 updated, 1 failed/);
  assert.match(frame, /Updated portable\/one/);
  assert.match(frame, /Failed App: bad/);
  assert.match(frame, /Updated App: good/);
});

test("App inventory failure leaves user-global Skill updates available", async t => {
  const f = await fixture(t);
  await seedGlobal(f, { name: "one", state: "outdated" });
  const recipesDirectory = path.join(f.home, "not-a-directory");
  await writeFile(recipesDirectory, "invalid directory");
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, appEnvironment: { recipesDirectory } }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  const frame = await expandList(view.lastFrame, view.stdin, frame => frame.includes("Error (Apps)") && frame.includes("portable/one"));
  assert.ok(!frame.includes("Error (user-global)"));
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /1 selected/);
  view.stdin.write(ENTER);
  await reviewToEnd(view.lastFrame, view.stdin, /Apply 1 update/);
  view.stdin.write("y");
  await waitForFrame(view.lastFrame, /Update summary: 1 updated, 0 failed/);
});

const packageSelection: PackageSelection = {
  host: "pi",
  root: "plugins/pstack",
  source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
  version: { policy: "latest" },
};

const packageDescriptor: BundleDescriptor = {
  host: "pi",
  coordinates: { host: "pi", root: "plugins/pstack" },
  name: "pstack",
  version: { kind: "manifest-version", version: "1.1.0", declaredBy: "bundle" },
  components: [
    { kind: "skills", ownership: "skill-category", effect: "instruction", paths: ["plugins/pstack/skills"], skillNames: ["how"] },
    { kind: "extensions", ownership: "host-only", effect: "executable", paths: ["plugins/pstack/extensions/index.ts"] },
  ],
  warnings: [],
  installable: true,
  manifestDigest: "c".repeat(64),
};

const packageRecord: InstalledPackage = {
  selection: packageSelection,
  installId: "pi:github.com/iseoane/pstack",
  verified: { kind: "manifest-version", version: "1.0.0", declaredBy: "bundle" },
  verifiedAt: "2026-01-01T00:00:00.000Z",
};

const packagePlan: PackageLifecyclePlan = {
  selection: packageSelection,
  action: "update",
  descriptor: packageDescriptor,
  commands: [{
    purpose: "apply",
    executable: "pi",
    resolvedPath: "/usr/bin/pi",
    args: ["update", "github.com/iseoane/pstack"],
    summary: "pi update",
  }],
  affects: [{ host: "pi", root: "plugins/pstack" }],
  warnings: [],
  cwd: "/home/user",
  environment: "linux",
  origin: { manifestDigest: packageDescriptor.manifestDigest, installId: packageRecord.installId },
};

test("a recorded Package joins the batch, previews its frozen plan and approves before updating", async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  const packages = fakePackageOperations({
    checkUpdates: async () => [{
      installed: packageRecord,
      observed: { kind: "installed", version: "1.0.0" },
      status: "update available",
      available: { kind: "git-commit", commit: "abcdef1234567890" },
    }],
    planLifecycle: async (_selection, action) => {
      calls.push(`plan:${action}`);
      return packagePlan;
    },
    approvalStatus: async (_selection, action = "install") => {
      calls.push(`approval:${action}`);
      return "needs approval";
    },
    approve: async (_selection, action = "install") => {
      calls.push(`approve:${action}`);
    },
    executeLifecycle: async (plan) => {
      calls.push(`execute:${plan.action}`);
      return { status: "updated", previous: { kind: "installed", version: "1.0.0" }, verified: { kind: "installed", version: "1.1.0" } };
    },
  });
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, packages }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  const listed = await expandList(view.lastFrame, view.stdin, /Package: pstack {2}plugins\/pstack/);
  assert.match(listed, /1\.0\.0 -> abcdef1/);
  press(view.stdin, "a");
  await waitForFrame(view.lastFrame, /1 selected/);
  press(view.stdin, ENTER);
  const preview = await reviewToEnd(view.lastFrame, view.stdin, /Apply 1 update\?/);
  assert.match(preview, /Step 1: apply\s+│\n│ {4}\$ pi update github\.com\/iseoane\/pstack/);
  assert.match(preview, /Approval: needs approval/);
  assert.match(preview, /runs a host process/);
  assert.match(preview, /This apply approves the declaration above\./);
  assert.deepEqual(calls, ["plan:update", "approval:update"]);
  press(view.stdin, "y");
  await waitForFrame(view.lastFrame, frame => squash(frame).includes("UpdatedPackage:pstack(pi)frombuiltin:agent-depot::pi:plugins/pstack:installed1.0.0->installed1.1.0"));
  assert.deepEqual(calls, ["plan:update", "approval:update", "approve:update", "execute:update"]);
});

test("Package Updates shows observed host version and commit rather than the remembered receipt", async t => {
  const f = await fixture(t);
  const packages = fakePackageOperations({ checkUpdates: async () => [{
    installed: packageRecord,
    observed: { kind: "installed", version: "1.6.1", commit: "a".repeat(40) },
    status: "update available",
    available: { kind: "manifest-version", version: "1.6.1", declaredBy: "bundle" },
    availableCommit: "b".repeat(40),
  }] });
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, packages }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  const listed = await expandList(view.lastFrame, view.stdin, /Package: pstack {2}plugins\/pstack/);
  assert.ok(squash(listed).includes("1.6.1(aaaaaaa)->1.6.1(bbbbbbb)"));
  assert.doesNotMatch(listed, /1\.0\.0/);
});

test("an unchanged Claude cache version explains source changes without offering an update", async t => {
  const f = await fixture(t);
  const packages = fakePackageOperations({ checkUpdates: async () => [{
    installed: { ...packageRecord, selection: { host: "claude", marketplaceRoot: "", pluginName: "demo",
      source: packageSelection.source, version: { policy: "latest" } } },
    observed: { kind: "installed", version: "1.6.1", commit: "a".repeat(40) },
    status: "current", available: { kind: "manifest-version", version: "1.6.1", declaredBy: "bundle" },
    availableCommit: "b".repeat(40),
    reason: "The Source commit differs, but Claude caches plugin version 1.6.1; the publisher must change the declared plugin version to deliver those changes.",
  }] });
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, packages }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  const listed = await waitForFrame(view.lastFrame, /publisher must change/);
  const flat = squash(listed);
  assert.ok(flat.includes("Claudecachespluginversion1.6.1"));
  assert.ok(flat.includes("Package:builtin:agent-depot::claude#demo:"));
  assert.doesNotMatch(listed, /:\.#|:\.\s/);
  assert.doesNotMatch(listed, /demo@\./);
  assert.doesNotMatch(listed, /\[ \] Package:/);
});

test("an unknown Package is folded with its reason and is never offered as an update", async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  const packages = fakePackageOperations({
    checkUpdates: async () => [{
      installed: packageRecord,
      status: "unknown",
      reason: "Pi reports this Package installed, but the Pi Git checkout has local modifications. Update assessment is unavailable; inspect the checkout before updating.",
    }],
    planLifecycle: async () => {
      calls.push("plan");
      return packagePlan;
    },
  });
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, packages }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  const folded = await waitForFrame(view.lastFrame, /1 cannot be checked/);
  assert.match(folded, /Package update comparison unavailable because the checkout has local\s+changes/);
  assert.ok(!folded.includes("Package: builtin:agent-depot::pi:plugins/pstack"), "an unknown Package is never offered as an update");
  press(view.stdin, ENTER);
  const open = await waitForFrame(view.lastFrame, /Update comparison unavailable: Pi reports this Package installed/);
  assert.match(open, /Package: builtin:agent-depot::pi:plugins\/pstack/);
  assert.ok(!open.includes("1 selected"));
  assert.deepEqual(calls, []);
});


/** Expands every group by walking down the tree; right does nothing on a row, so extra steps are harmless. */
function expandAll(stdin: Stdin, steps = 30) {
  for (let step = 0; step < steps; step += 1) {
    press(stdin, RIGHT);
    press(stdin, "j");
  }
  for (let step = 0; step < steps; step += 1) press(stdin, "k");
}

const line = (frame: string, text: string) => frame.split("\n").find((candidate) => candidate.includes(text)) ?? "";

test("Updates groups by Source with Skills below it, and every group starts collapsed", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "remote", state: "outdated", url: GIT_URL },
  ]);
  const { lastFrame, unmount } = mount(f);
  const frame = await waitForFrame(lastFrame, /▸ builtin:agent-depot \(2\)/);
  assert.match(frame, /▸ https:\/\/example\.com\/skills\.git \(1\)/);
  assert.ok(!frame.includes("Skills ("), "subgroups are hidden under a collapsed Source");
  assert.ok(!frame.includes("portable/one"), "rows are hidden under a collapsed Source");
  assert.match(frame, /0 selected/);
  unmount();
});

test("right expands a group, left collapses it, and left on a row selects its parent group", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /▸ builtin:agent-depot \(1\)/);
  press(stdin, RIGHT);
  const source = await waitForFrame(lastFrame, /▾ builtin:agent-depot \(1\)/);
  assert.match(source, /▸ Skills \(1\)/);
  press(stdin, "j");
  press(stdin, RIGHT);
  const rows = await waitForFrame(lastFrame, /portable\/one/);
  assert.match(rows, /▾ Skills \(1\)/);
  press(stdin, "j");
  press(stdin, LEFT);
  await waitForFrame(lastFrame, (frame) => /^> .*▾ Skills \(1\)/m.test(frame));
  press(stdin, LEFT);
  await waitForFrame(lastFrame, (frame) => /^> .*▸ Skills \(1\)/m.test(frame) && !frame.includes("portable/one"));
  unmount();
});

test("Enter on a group expands it instead of previewing", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /▸ builtin:agent-depot \(1\)/);
  press(stdin, ENTER);
  const frame = await waitForFrame(lastFrame, /▾ builtin:agent-depot \(1\)/);
  assert.ok(!frame.includes("Update batch preview"));
  assert.ok(!frame.includes("Select at least one"));
  unmount();
});

test("space on a collapsed group selects and unselects all its rows, showing [x], [-] and [ ]", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "remote", state: "outdated", url: GIT_URL },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /▸ builtin:agent-depot \(2\)/);
  press(stdin, " ");
  const all = await waitForFrame(lastFrame, /2 selected/);
  assert.match(line(all, "builtin:agent-depot"), /\[x\]/);
  assert.match(line(all, "example.com/skills.git"), /\[ \]/);
  press(stdin, " ");
  const none = await waitForFrame(lastFrame, /0 selected/);
  assert.match(line(none, "builtin:agent-depot"), /\[ \]/);
  press(stdin, RIGHT);
  press(stdin, "j");
  press(stdin, RIGHT);
  press(stdin, "j");
  press(stdin, " ");
  const some = await waitForFrame(lastFrame, /1 selected/);
  assert.match(line(some, "▾ builtin:agent-depot"), /\[-\]/);
  assert.match(line(some, "portable/one"), /\[x\]/);
  unmount();
});

test("rows selected under a collapsed group are exactly what the preview receives", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
    { name: "remote", state: "outdated", url: GIT_URL },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /▸ builtin:agent-depot \(2\)/);
  press(stdin, " ");
  await waitForFrame(lastFrame, /2 selected/);
  press(stdin, "u");
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 2 updates\?/);
  assert.match(preview, /portable\/one/);
  assert.match(preview, /portable\/two/);
  assert.ok(!preview.includes("portable/remote"));
  unmount();
});

test("the scope filter hides groups that have no row left", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated" }]);
  await seedGlobal(f, { name: "glob", state: "outdated", url: GIT_URL });
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /▸ https:\/\/example\.com\/skills\.git \(1\)/);
  press(stdin, "p");
  const project = await waitForFrame(lastFrame, (frame) => /scope: project/.test(frame) && frame.includes("builtin:agent-depot"));
  assert.ok(!project.includes("example.com/skills.git"));
  unmount();
});

test("group headers take part in windowing", async (t) => {
  const f = await fixture(t);
  await seedProject(f, Array.from({ length: 4 }, (_, n): SkillSpec => ({ name: `s${n}`, state: "outdated", url: `https://example.com/r${n}.git` })));
  const { lastFrame, unmount } = render(<UpdatesView operations={f.operations} environment={f.environment} listHeight={2} />);
  const frame = await waitForFrame(lastFrame, /1–2 of 4/);
  assert.equal(frame.split("\n").filter((candidate) => /▸ https:\/\/example\.com\/r\d\.git/.test(candidate)).length, 2);
  unmount();
});

test("a root-level Package sits under its Source, named without a root", async t => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", url: GIT_URL }]);
  const packages = fakePackageOperations({ checkUpdates: async () => [{
    installed: { ...packageRecord, selection: { host: "claude", marketplaceRoot: "", pluginName: "demo", source: { kind: "external", url: GIT_URL }, version: { policy: "latest" } } },
    observed: { kind: "installed", version: "1.0.0" },
    status: "update available",
    available: { kind: "git-commit", commit: "abcdef1234567890" },
  }] });
  const { lastFrame, stdin, unmount } = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, packages }} />);
  deferCleanup(t, () => { unmount(); });
  await waitForFrame(lastFrame, /▸ https:\/\/example\.com\/skills\.git \(2\)/);
  expandAll(stdin);
  const frame = await waitForFrame(lastFrame, /Package: demo/);
  assert.match(frame, /▾ Packages \(1\)/);
  assert.match(frame, /▾ Skills \(1\)/);
  assert.ok(frame.indexOf("Packages (1)") < frame.indexOf("Skills (1)"));
  assert.doesNotMatch(frame, /demo@\.|Package: \.|Package: demo {2}\./);
  assert.ok(frame.indexOf("Package: demo") < frame.indexOf("portable/one"));
});

test("a then u at the default cursor on a collapsed group previews every row", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated" },
    { name: "two", state: "outdated" },
  ]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /▸ builtin:agent-depot \(2\)/);
  press(stdin, "a");
  await waitForFrame(lastFrame, /2 selected/);
  press(stdin, "u");
  const preview = await reviewToEnd(lastFrame, stdin, /Apply 2 updates\?/);
  assert.match(preview, /portable\/one/);
  assert.match(preview, /portable\/two/);
  unmount();
});

test("a root-level Package result names its Source without a root segment", async t => {
  const f = await fixture(t);
  const rootPlan: PackageLifecyclePlan = { ...packagePlan, selection: { ...packageSelection, host: "claude", marketplaceRoot: "", pluginName: "pstack" } as PackageSelection };
  const packages = fakePackageOperations({
    checkUpdates: async () => [{ installed: { ...packageRecord, selection: rootPlan.selection }, observed: { kind: "installed", version: "1.0.0" }, status: "update available", available: { kind: "git-commit", commit: "abcdef1234567890" } }],
    planLifecycle: async () => rootPlan,
    approvalStatus: async () => "approved",
    executeLifecycle: async () => ({ status: "updated", previous: { kind: "installed", version: "1.0.0" }, verified: { kind: "installed", version: "1.1.0" } }),
  });
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, packages }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  await expandList(view.lastFrame, view.stdin, /Package: pstack/);
  press(view.stdin, "a");
  press(view.stdin, "u");
  await reviewToEnd(view.lastFrame, view.stdin, /Apply 1 update\?/);
  press(view.stdin, "y");
  const done = await waitForFrame(view.lastFrame, /Updated Package: pstack/);
  assert.ok(squash(done).includes("UpdatedPackage:pstack(claude)frombuiltin:agent-depot::claude#pstack:"));
});

for (const size of PREVIEW_SIZES) {
  test(`the update batch preview accepts y exactly when its footer reads to the end at ${size.columns}x${size.rows}`, async (t) => {
    const f = await fixture(t);
    await seedProject(f, [{ name: "one", state: "outdated", method: ["node", "--fake-update"] }]);
    const view = mount(f);
    await expandList(view.lastFrame, view.stdin, /portable\/one/);
    resizeTerminal(view, size);
    press(view.stdin, "a");
    press(view.stdin, ENTER);
    const end = await confirmAtEnd(view, size.rows, /\[y\] Apply 1 update/, () => f.methodCalls.length > 0);
    assert.match(squash(end), /Apply1update\?y\/n/);
    await waitForFrame(view.lastFrame, frame => squash(frame).includes("1updated,0failed"));
    view.unmount();
  });
}

for (const size of PREVIEW_SIZES) {
  test(`replacing non-canonical paths waits for the end of their list in the shared footer at ${size.columns}x${size.rows}`, async (t) => {
    const f = await fixture(t);
    await seedProject(f, [{ name: "one", state: "outdated", installPath: "tools/skills/one" }]);
    const view = mount(f);
    await expandList(view.lastFrame, view.stdin, /portable\/one/);
    resizeTerminal(view, size);
    press(view.stdin, "a");
    press(view.stdin, ENTER);
    await confirmAtEnd(view, size.rows, /\[y\] Apply 1 update/, () => /Outside \.agents\/skills/.test(view.lastFrame() ?? ""));
    await confirmAtEnd(view, size.rows, /\[y\] Replace these paths/, () => squash(view.lastFrame() ?? "").includes("1updated,0failed"));
    assert.equal(await f.read(f.project, "tools/skills/one"), newText("one"));
    view.unmount();
  });
}

test("a y pasted in the same block as the cursor moves does not confirm the update batch", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", method: ["node", "--fake-update"] }]);
  const view = mount(f);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  await expandList(view.lastFrame, view.stdin, /portable\/one/);
  resizeTerminal(view, { columns: 40, rows: 17 });
  press(view.stdin, "a");
  press(view.stdin, ENTER);
  await waitForFrame(view.lastFrame, /read [█░]* ?\d+%|read ✓/u);
  press(view.stdin, `${"j".repeat(200)}y`);
  await waitForFrame(view.lastFrame, frame => /read ✓/u.test(frame) || squash(frame).includes("1updated"));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.methodCalls.length, 0, "the y in the burst ran the update");
  assert.match(view.lastFrame() ?? "", /read ✓/u);
  assert.match(squash(view.lastFrame() ?? ""), /\[y\]Apply1update/u);
  press(view.stdin, "y");
  await waitForFrame(view.lastFrame, frame => squash(frame).includes("1updated,0failed"));
  assert.equal(f.methodCalls.length, 1);
});

for (const [name, burst] of [["Down arrows", `${"\u001B[B".repeat(200)}y`], ["Page Down", `${"\u001B[6~".repeat(200)}y`]] as const) {
  test(`a y read in the same chunk as ${name} does not confirm the update batch`, async (t) => {
    const f = await fixture(t);
    await seedProject(f, [{ name: "one", state: "outdated", method: ["node", "--fake-update"] }]);
    const view = mount(f);
    deferCleanup(t, () => { view.unmount(); view.cleanup(); });
    await expandList(view.lastFrame, view.stdin, /portable\/one/);
    resizeTerminal(view, { columns: 40, rows: 17 });
    press(view.stdin, "a");
    press(view.stdin, ENTER);
    await waitForFrame(view.lastFrame, /read [█░]* ?\d+%|read ✓/u);
    press(view.stdin, burst);
    await waitForFrame(view.lastFrame, frame => /read ✓/u.test(frame) || squash(frame).includes("1updated"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.methodCalls.length, 0, "the y in the chunk ran the update");
    assert.match(view.lastFrame() ?? "", /read ✓/u);
    press(view.stdin, "y");
    await waitForFrame(view.lastFrame, frame => squash(frame).includes("1updated,0failed"));
    assert.equal(f.methodCalls.length, 1);
  });
}

test("the update batch preview opens with the count per type and its warnings, then one section per type", async t => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "one", state: "outdated", diskContent: "edited by hand" }]);
  const recipesDirectory = path.join(f.home, "apps");
  await mkdir(recipesDirectory);
  await writeFile(path.join(recipesDirectory, "demo.json"), JSON.stringify({
    name: "demo", install: { manual: "install" }, uninstall: { manual: "remove" }, update: { argv: ["demo", "update", "--note", "two words"] },
    version: { argv: ["demo", "version"], pattern: "(\\S+)" }, latest: { npm: "demo" },
  }));
  const appEnvironment = { recipesDirectory, homeDirectory: f.home,
    resolveExecutable: async (name: string) => `/usr/bin/${name}`,
    fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "2.0.0" } })),
    runner: async () => ({ code: 0, signal: null, stdout: Buffer.from("1.0.0"), stderr: "", outputTooLarge: false }),
  };
  const apps = createAppOperations(appEnvironment);
  for (const entry of await apps.load()) await apps.approve(entry);
  const packages = fakePackageOperations({
    checkUpdates: async () => [{ installed: packageRecord, observed: { kind: "installed", version: "1.0.0" }, status: "update available",
      available: { kind: "manifest-version", version: "1.1.0", declaredBy: "bundle" } }],
    planLifecycle: async () => packagePlan,
    approvalStatus: async () => "needs approval",
  });
  const view = render(<UpdatesView operations={f.operations} environment={{ ...f.environment, appEnvironment, packages }} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  await expandList(view.lastFrame, view.stdin, frame => frame.includes("App: demo") && frame.includes("portable/one") && frame.includes("Package: pstack"));
  resizeTerminal(view, { columns: 120, rows: 200 });
  press(view.stdin, "a");
  await waitForFrame(view.lastFrame, /3 selected/);
  press(view.stdin, ENTER);
  const frame = await waitForFrame(view.lastFrame, /read ✓/);
  const rows = frame.split("\n").map(row => row.replace(/^│\s?|\s*│$/gu, ""));
  const at = (pattern: RegExp) => rows.findIndex(row => pattern.test(row));
  const header = at(/Apply 3 updates {2}1 Skill · 1 App · 1 Package/u);
  const skills = at(/^ *SKILLS$/u);
  const appsHeading = at(/^ *APPS$/u);
  const packagesHeading = at(/^ *PACKAGES$/u);
  assert.ok(header >= 0 && header < skills && skills < appsHeading && appsHeading < packagesHeading, `header, then SKILLS, APPS and PACKAGES in order:\n${frame}`);
  const topWarning = at(/⚠ portable\/one: the installed Skill has local modifications/u);
  assert.ok(topWarning > header && topWarning < skills, `the local-modification warning is collected at the top:\n${frame}`);
  const itemWarning = rows.findIndex((row, index) => index > skills && index < appsHeading && /⚠ the installed Skill has local modifications/u.test(row));
  assert.ok(itemWarning > skills, `the warning is repeated in its Skill:\n${frame}`);
  assert.match(rows[skills + 1] ?? "", /portable\/one {2}builtin:agent-depot · project {2}0\.0\.1 → /u);
  const app = at(/demo {2}1\.0\.0 → 2\.0\.0/u);
  assert.ok(app > appsHeading && app < packagesHeading, `the App block shows its version arrow:\n${frame}`);
  assert.match(rows[app + 1] ?? "", /\$ demo update --note "two words"$/u);
  assert.match(rows[app + 2] ?? "", new RegExp(`/usr/bin/demo · in ${f.home.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}`, "u"));
  const pkg = at(/pstack {2}pi {2}1\.0\.0 → 1\.1\.0/u);
  assert.ok(pkg > packagesHeading, `the Package block shows its installed and available versions:\n${frame}`);
  assert.ok(rows.slice(pkg).some(row => /\$ pi update github\.com\/iseoane\/pstack$/u.test(row)), `the Package command reads as a shell line:\n${frame}`);
  assert.ok(rows.slice(pkg).some(row => /Approval: needs approval/u.test(row)));
  assert.ok(rows.slice(pkg).some(row => /This apply approves the declaration above\./u.test(row)));
  assert.match(squash(frame), /replacesportable\/one'slocalchanges·runs2commands·Apply3updates\?y\/n/u);
});

test("the update batch preview lists the items it could not preview in their own section", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [{ name: "good", state: "outdated" }, { name: "bad", state: "outdated" }]);
  const operations: SourceOperations = {
    ...f.operations,
    async readInstallationMethod(_source, skillPath) {
      if (skillPath === "portable/bad") throw new Error("cannot read install metadata");
      return undefined;
    },
  };
  const view = render(<UpdatesView operations={operations} environment={f.environment} />);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  await expandList(view.lastFrame, view.stdin, /portable\/bad/);
  resizeTerminal(view, { columns: 120, rows: 200 });
  press(view.stdin, "a");
  press(view.stdin, ENTER);
  const frame = await waitForFrame(view.lastFrame, /read ✓/);
  const rows = frame.split("\n").map(row => row.replace(/^│\s?|\s*│$/gu, ""));
  assert.match(frame, /Apply 1 update {2}1 Skill/u);
  const failed = rows.findIndex(row => /^ *FAILED$/u.test(row));
  assert.ok(failed > rows.findIndex(row => /^ *SKILLS$/u.test(row)), `failures follow the applicable items:\n${frame}`);
  assert.match(rows[failed + 1] ?? "", /portable\/bad: cannot read install metadata/u);
});

test("at 40x17 the batch footer still asks its question when several Skills lose local changes", async (t) => {
  const f = await fixture(t);
  await seedProject(f, [
    { name: "one", state: "outdated", diskContent: "edited by hand" },
    { name: "two", state: "outdated", diskContent: "edited by hand" },
    { name: "three", state: "outdated", diskContent: "edited by hand" },
  ]);
  const view = mount(f);
  deferCleanup(t, () => { view.unmount(); view.cleanup(); });
  await expandList(view.lastFrame, view.stdin, /portable\/three/);
  resizeTerminal(view, { columns: 40, rows: 17 });
  press(view.stdin, "a");
  press(view.stdin, ENTER);
  const end = await confirmAtEnd(view, 17, /\[y\] Apply 3 updates/, () => squash(view.lastFrame() ?? "").includes("3updated,0failed"));
  assert.match(squash(end), /Apply3updates\?y\/n/u);
});
