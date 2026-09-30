import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import { AGENT_DEPOT_PACKAGE_VERSION, parseProjectManifest, type ProjectHost } from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillCandidate, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const ESC = "\u001B";
const ENTER = "\r";

const tree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Uint8Array.from([0x23, 0x23, 0x20, 0x44]), executable: false },
];
const demo: SkillCandidate = { sourceId: BUILT_IN_SOURCE.id, path: "portable/demo", name: "demo", description: "Demo skill" };

interface Fixture {
  readonly operations: SourceOperations;
  readonly environment: TuiEnvironment;
  readonly home: string;
}

const canonical = (home: string) => path.join(home, ".agents", "skills", "demo");
const claude = (home: string) => path.join(home, ".claude", "skills", "demo");
const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

/** A user-global installation of `demo` under a temp home, with the Claude symlink when claude is a host. */
async function fixture(t: TestContext, hosts: readonly ProjectHost[]): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-hosts-home-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-hosts-state-"));
  t.after(async () => {
    await Promise.all([home, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = { ...real, discoverSkills: async () => [demo] };
  await mkdir(canonical(home), { recursive: true });
  await writeFile(path.join(canonical(home), "SKILL.md"), "## D", "utf8");
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
  return { operations, home, environment: { homeDirectory: home, projectRoot: home } };
}

const key = async (stdin: { write(data: string): void }, data: string) => {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 15));
};

const hostsOf = async (operations: SourceOperations) => (await operations.listUserGlobalInstallations!())[0]?.hosts;

function mount(f: Fixture, onCapturingChange?: (capturing: boolean) => void) {
  return render(
    <CatalogView operations={f.operations} sourceId={BUILT_IN_SOURCE.id} environment={f.environment} onCapturingChange={onCapturingChange} />,
  );
}

test("u on an installation with several hosts asks for all hosts or a host checklist", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi, claude\]/);
  await key(stdin, "u");
  await waitForFrame(lastFrame, /1 all hosts.*2 choose hosts/s);
  await key(stdin, "1");
  const preview = await waitForFrame(lastFrame, /removes the whole user-global installation, from hosts: pi, claude/);
  assert.match(preview, /y\/n/);
  unmount();
});

test("u with one host goes straight to the full removal preview", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi\]/);
  await key(stdin, "u");
  const preview = await waitForFrame(lastFrame, /y\/n/);
  assert.ok(!preview.includes("all hosts"));
  assert.match(preview, /removes the whole user-global installation/);
  unmount();
});

test("choosing hosts removes only those hosts and reloads the marker", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi, claude\]/);
  await key(stdin, "u");
  await key(stdin, "2");
  await waitForFrame(lastFrame, /\[ \] 1 pi.*\[ \] 2 claude/s);
  await key(stdin, "2");
  await key(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /y\/n/);
  assert.match(preview, /remove hosts claude from "portable\/demo"; remaining hosts: pi/);
  assert.ok(await exists(claude(f.home)));
  await key(stdin, "y");
  const done = await waitForFrame(lastFrame, /Removed hosts claude/);
  assert.match(done, /\[global: pi\]/);
  assert.equal(await exists(claude(f.home)), false);
  assert.ok(await exists(canonical(f.home)));
  assert.deepEqual(await hostsOf(f.operations), ["pi"]);
  unmount();
});

test("selecting every host in the checklist is a full removal", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi, claude\]/);
  await key(stdin, "u");
  await key(stdin, "2");
  await key(stdin, "1");
  await key(stdin, "2");
  await key(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  await key(stdin, "y");
  const done = await waitForFrame(lastFrame, /Removed demo/);
  assert.ok(!done.includes("[global"));
  assert.equal(await exists(canonical(f.home)), false);
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  unmount();
});

test("the removal host checklist requires a host and Esc cancels without changes", async (t) => {
  const f = await fixture(t, ["pi", "claude"]);
  const changes: boolean[] = [];
  const { lastFrame, stdin, unmount } = mount(f, (value) => changes.push(value));
  await waitForFrame(lastFrame, /\[global: pi, claude\]/);
  await key(stdin, "u");
  await key(stdin, "2");
  await key(stdin, ENTER);
  await waitForFrame(lastFrame, /Select at least one host/);
  assert.equal(changes.at(-1), true);
  await key(stdin, ESC);
  await waitForFrame(lastFrame, /Uninstall cancelled/);
  assert.equal(changes.at(-1), false);
  assert.deepEqual(await hostsOf(f.operations), ["pi", "claude"]);
  unmount();
});

test("i on a globally installed Skill offers adding only the missing hosts, with two confirmations", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi\]/);
  await key(stdin, "i");
  await waitForFrame(lastFrame, /1 add hosts.*2 new install/s);
  await key(stdin, "1");
  const checklist = await waitForFrame(lastFrame, /\[ \] 1 claude/);
  assert.ok(!/\d pi/.test(checklist));
  await key(stdin, "1");
  await key(stdin, ENTER);
  const preview = await waitForFrame(lastFrame, /y\/n/);
  assert.match(preview, /add hosts claude to "portable\/demo"/);
  assert.match(preview, /\.claude\/skills\/demo/);
  assert.equal(await exists(claude(f.home)), false);
  await key(stdin, "y");
  await waitForFrame(lastFrame, /needs separate confirmation/);
  assert.equal(await exists(claude(f.home)), false);
  await key(stdin, "y");
  const done = await waitForFrame(lastFrame, /Added hosts claude/);
  assert.match(done, /\[global: pi, claude\]/);
  assert.ok(await exists(claude(f.home)));
  assert.deepEqual(await hostsOf(f.operations), ["pi", "claude"]);
  unmount();
});

test("declining the additional-host confirmation changes nothing", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi\]/);
  await key(stdin, "i");
  await key(stdin, "1");
  await key(stdin, "1");
  await key(stdin, ENTER);
  await waitForFrame(lastFrame, /y\/n/);
  await key(stdin, "y");
  await waitForFrame(lastFrame, /needs separate confirmation/);
  await key(stdin, "n");
  await waitForFrame(lastFrame, /cancelled/i);
  assert.equal(await exists(claude(f.home)), false);
  assert.deepEqual(await hostsOf(f.operations), ["pi"]);
  unmount();
});

test("adding a host over a conflicting location shows the error and changes nothing", async (t) => {
  const f = await fixture(t, ["pi"]);
  await mkdir(claude(f.home), { recursive: true });
  await writeFile(path.join(claude(f.home), "SKILL.md"), "different", "utf8");
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi\]/);
  await key(stdin, "i");
  await key(stdin, "1");
  await key(stdin, "1");
  await key(stdin, ENTER);
  await waitForFrame(lastFrame, /already exists/);
  assert.deepEqual(await hostsOf(f.operations), ["pi"]);
  unmount();
});

test("choosing new install on a globally installed Skill continues the ordinary install steps", async (t) => {
  const f = await fixture(t, ["pi"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi\]/);
  await key(stdin, "i");
  await key(stdin, "2");
  await waitForFrame(lastFrame, /Host \(space/);
  unmount();
});

test("i on a Skill that already has every host goes straight to the ordinary install steps", async (t) => {
  const f = await fixture(t, ["pi", "claude", "codex", "opencode"]);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitForFrame(lastFrame, /\[global: pi, claude, codex, opencode\]/);
  await key(stdin, "i");
  await waitForFrame(lastFrame, /Host \(space/);
  unmount();
});
