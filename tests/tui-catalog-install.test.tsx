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
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";

const ESC = "\u001B";
const ENTER = "\r";

const tree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Uint8Array.from([0x23, 0x23, 0x20, 0x44]), executable: false },
  { path: "portable/demo/scripts/run.sh", content: Uint8Array.from([0x23, 0x21, 0x2f, 0x62]), executable: true },
];
const resolvedVersion = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };
const demo: SkillCandidate = {
  sourceId: BUILT_IN_SOURCE.id,
  path: "portable/demo",
  name: "demo",
  description: "Demo skill",
};

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
}

async function fixture(t: TestContext, withStateOperations = true): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = withStateOperations
    ? { ...real, discoverSkills: async () => [demo] }
    : {
        addGitSource: real.addGitSource,
        listSources: real.listSources,
        refreshSource: real.refreshSource,
        selectSources: real.selectSources,
        discoverSkills: async () => [demo],
      };
  return { operations, home, project, environment: { homeDirectory: home, projectRoot: project, sourceAccess } };
}

function selection(hosts: readonly ProjectHost[]): ProjectSkillSelection {
  return parseProjectManifest({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts,
      installation: { path: ".agents/skills/demo", adopted: false, resolvedVersion, baseline: skillTreeBaseline(tree) },
    }],
  }).skills[0]!;
}

async function waitFor(frame: () => string | undefined, pattern: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = frame() ?? "";
    if (pattern.test(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${pattern}; last frame:\n${frame()}`);
}

const key = async (stdin: { write(data: string): void }, data: string) => {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 15));
};

function mount(f: Fixture, onCapturingChange?: (capturing: boolean) => void) {
  const view = render(
    <CatalogView
      operations={f.operations}
      sourceId={BUILT_IN_SOURCE.id}
      environment={f.environment}
      onCapturingChange={onCapturingChange}
    />,
  );
  return view;
}

test("Catalog shows global and project installed markers", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(selection(["claude", "codex"]));
  await new ProjectManifestStore(defaultProjectManifestPath(f.project)).save(
    parseProjectManifest({ version: 1, skills: [selection(["pi"])] }),
  );
  const { lastFrame, unmount } = mount(f);
  const frame = await waitFor(lastFrame, /\[project: pi\]/);
  const line = frame.split("\n").find((entry) => entry.includes("demo")) ?? "";
  assert.match(line, /\[global: claude, codex\]/);
  unmount();
});

test("Catalog without installation operations shows no marker and does not crash", async (t) => {
  const f = await fixture(t, false);
  const { lastFrame, stdin, unmount } = mount(f);
  const frame = await waitFor(lastFrame, /demo/);
  assert.ok(!frame.includes("[global"));
  await key(stdin, "u");
  await waitFor(lastFrame, /not supported/i);
  unmount();
});

type Stdin = { write(data: string): void };

/** Drives the install steps: toggles the given host keys, then picks scope and version. */
async function chooseInstall(stdin: Stdin, hostKeys: readonly string[], scopeKey: string, versionKey: string) {
  await key(stdin, "i");
  for (const hostKey of hostKeys) await key(stdin, hostKey);
  await key(stdin, ENTER);
  await key(stdin, scopeKey);
  await key(stdin, versionKey);
}

test("i installs user-global step by step with a multi-host preview and confirmation", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await key(stdin, "i");
  await waitFor(lastFrame, /\[ \] 1 pi.*\[ \] 2 claude.*\[ \] 3 codex.*\[ \] 4 opencode/s);
  await key(stdin, " ");
  await key(stdin, "j");
  await key(stdin, " ");
  await key(stdin, "3");
  await waitFor(lastFrame, /\[x\] 1 pi.*\[x\] 2 claude.*\[x\] 3 codex.*\[ \] 4 opencode/s);
  await key(stdin, " ");
  await waitFor(lastFrame, /\[x\] 1 pi.*\[ \] 2 claude.*\[x\] 3 codex/s);
  await key(stdin, " ");
  await key(stdin, ENTER);
  await waitFor(lastFrame, /Scope:.*1 project.*2 user-global/s);
  await key(stdin, "2");
  await waitFor(lastFrame, /Version:.*1 latest.*2 fixed/s);
  await key(stdin, "1");
  const preview = await waitFor(lastFrame, /y\/n/);
  assert.match(preview, /scope: user-global; hosts: pi,claude,codex; version policy: latest/);
  assert.match(preview, /portable\/demo\/SKILL\.md/);
  assert.ok(!preview.includes("no --yes supplied"));
  assert.ok(!preview.includes("ADDITIONAL HOST EXPOSURE"));
  await assert.rejects(readFile(path.join(f.home, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  await key(stdin, "y");
  const done = await waitFor(lastFrame, /Installed Skill "demo"/);
  assert.match(done, /\[global: pi, claude, codex\]/);
  assert.equal(await readFile(path.join(f.home, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
  unmount();
});

test("host step requires at least one host", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await key(stdin, "i");
  await key(stdin, ENTER);
  const frame = await waitFor(lastFrame, /Select at least one host/);
  assert.match(frame, /Host/);
  assert.ok(!/Scope:.*1 project/s.test(frame));
  unmount();
});

test("n declines the install preview without changing anything", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["2"], "2", "1");
  await waitFor(lastFrame, /y\/n/);
  await key(stdin, "n");
  const frame = await waitFor(lastFrame, /Install cancelled/);
  assert.ok(!frame.includes("[global"));
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  await assert.rejects(readFile(path.join(f.home, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  unmount();
});

test("i installs into the project manifest and shows the project marker", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["3"], "1", "1");
  const preview = await waitFor(lastFrame, /y\/n/);
  assert.match(preview, /scope: project; hosts: codex/);
  await key(stdin, "y");
  const done = await waitFor(lastFrame, /\[project: codex\]/);
  assert.match(done, /Installed Skill "demo"/);
  const manifest = await new ProjectManifestStore(defaultProjectManifestPath(f.project)).load();
  assert.equal(manifest.skills.length, 1);
  assert.equal(await readFile(path.join(f.project, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
  unmount();
});

test("fixed version policy asks for the version text", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["1"], "2", "2");
  await waitFor(lastFrame, /Fixed version:/);
  for (const character of AGENT_DEPOT_PACKAGE_VERSION!) await key(stdin, character);
  await key(stdin, ENTER);
  const preview = await waitFor(lastFrame, /y\/n/);
  assert.match(preview, new RegExp(`version policy: fixed:${AGENT_DEPOT_PACKAGE_VERSION!.replaceAll(".", "\\.")}`));
  await key(stdin, "n");
  unmount();
});

test("adopting an identical Skill with a missing Host location needs a separate confirmation", async (t) => {
  const f = await fixture(t);
  const canonical = path.join(f.project, ".agents", "skills", "demo");
  for (const file of tree) {
    const destination = path.join(canonical, ...file.path.slice("portable/demo/".length).split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.content));
  }
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["1", "2"], "1", "1");
  const preview = await waitFor(lastFrame, /y\/n/);
  assert.match(preview, /ADDITIONAL HOST EXPOSURE/);
  await key(stdin, "y");
  const second = await waitFor(lastFrame, /--confirm-additional-host/);
  assert.match(second, /Confirm\? y\/n/);
  assert.deepEqual(await new ProjectManifestStore(defaultProjectManifestPath(f.project)).load().then((m) => m.skills), []);
  await key(stdin, "n");
  await waitFor(lastFrame, /Install cancelled/);
  assert.deepEqual(await new ProjectManifestStore(defaultProjectManifestPath(f.project)).load().then((m) => m.skills), []);

  await chooseInstall(stdin, ["1", "2"], "1", "1");
  await waitFor(lastFrame, /y\/n/);
  await key(stdin, "y");
  await waitFor(lastFrame, /--confirm-additional-host/);
  await key(stdin, "y");
  const done = await waitFor(lastFrame, /\[project: pi, claude\]/);
  assert.match(done, /Adopted Skill "demo"/);
  unmount();
});

/** A fixture whose only Source is an external Git Source, with a recording refresh seam. */
async function gitFixture(f: Fixture, refresh: (installedBefore: boolean) => Promise<void>, files: () => readonly SkillTreeFile[] = () => tree): Promise<{ readonly fixture: Fixture; readonly events: string[] }> {
  const git = await f.operations.addGitSource("https://example.com/ext.git");
  const events: string[] = [];
  const operations: SourceOperations = {
    ...f.operations,
    listSources: async () => [git],
    discoverSkills: async () => [{ ...demo, sourceId: git.id }],
    resolveProjectSource: async () => git,
    resolveSourceVersion: async () => undefined,
    refreshProjectSource: async () => {
      events.push("refresh");
      const installed = await readFile(path.join(f.home, ".agents", "skills", "demo", "SKILL.md")).then(() => true, () => false);
      await refresh(installed);
      return git;
    },
  };
  const gitAccess = {
    readSkillTree: async () => files(),
    readSkillTreeSnapshot: async () => ({ files: files() }),
  };
  return { fixture: { ...f, operations, environment: { ...f.environment, sourceAccess: gitAccess } }, events };
}

test("the Git Source is refreshed before the preview, which reflects the refreshed content; y does not refresh again", async (t) => {
  const f = await fixture(t);
  let current: readonly SkillTreeFile[] = tree;
  let installedAtRefresh: boolean | undefined;
  const { fixture: g, events } = await gitFixture(f, async (installed) => {
    installedAtRefresh = installed;
    current = [...tree, { path: "portable/demo/extra.md", content: Uint8Array.from([0x45]), executable: false }];
  }, () => current);
  const { lastFrame, stdin, unmount } = mount({ ...g });
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["2"], "2", "1");
  const preview = await waitFor(lastFrame, /y\/n/);
  assert.deepEqual(events, ["refresh"], "the refresh happens before the preview is shown");
  assert.match(preview, /portable\/demo\/extra\.md/);
  assert.equal(installedAtRefresh, false);
  await key(stdin, "y");
  await waitFor(lastFrame, /Installed Skill "demo"/);
  assert.deepEqual(events, ["refresh"], "confirming must not refresh again");
  assert.equal(await readFile(path.join(f.home, ".agents", "skills", "demo", "extra.md"), "utf8"), "E");
  unmount();
});

test("a failed refresh aborts the install with an error and writes nothing", async (t) => {
  const f = await fixture(t);
  const { fixture: g } = await gitFixture(f, async () => {
    throw new Error("network unreachable");
  });
  const { lastFrame, stdin, unmount } = mount({ ...g });
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["2"], "2", "1");
  await waitFor(lastFrame, /network unreachable/);
  await assert.rejects(readFile(path.join(f.home, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  unmount();
});

test("install shows an error when the Skill is already installed there", async (t) => {
  const f = await fixture(t);
  await f.operations.addUserGlobalInstallation!(selection(["claude"]));
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /\[global: claude\]/);
  await chooseInstall(stdin, ["2"], "2", "1");
  await waitFor(lastFrame, /already recorded/);
  unmount();
});

test("u previews the whole-installation removal, requires confirmation and reloads the marker", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await chooseInstall(stdin, ["2", "3"], "2", "1");
  await waitFor(lastFrame, /y\/n/);
  await key(stdin, "y");
  await waitFor(lastFrame, /\[global: claude, codex\]/);
  await key(stdin, "u");
  const preview = await waitFor(lastFrame, /remove "portable\/demo"/);
  assert.match(preview, /removes the whole user-global installation, from hosts: claude, codex/);
  assert.match(preview, /y\/n/);
  await key(stdin, "n");
  await waitFor(lastFrame, /Uninstall cancelled/);
  assert.equal((await f.operations.listUserGlobalInstallations!()).length, 1);
  await key(stdin, "u");
  await waitFor(lastFrame, /y\/n/);
  await key(stdin, "y");
  const done = await waitFor(lastFrame, /Removed/);
  assert.ok(!done.includes("[global"));
  assert.deepEqual(await f.operations.listUserGlobalInstallations!(), []);
  await assert.rejects(readFile(path.join(f.home, ".agents", "skills", "demo", "SKILL.md")), { code: "ENOENT" });
  unmount();
});

test("u on a project-only installation says project uninstall is not supported", async (t) => {
  const f = await fixture(t);
  await new ProjectManifestStore(defaultProjectManifestPath(f.project)).save(
    parseProjectManifest({ version: 1, skills: [selection(["codex"])] }),
  );
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /\[project: codex\]/);
  await key(stdin, "u");
  await waitFor(lastFrame, /Project uninstall is not supported/);
  unmount();
});

test("u on a Skill that is not installed says so", async (t) => {
  const f = await fixture(t);
  const { lastFrame, stdin, unmount } = mount(f);
  await waitFor(lastFrame, /demo/);
  await key(stdin, "u");
  await waitFor(lastFrame, /not installed/i);
  unmount();
});

test("install flow captures keys, and Esc cancels it", async (t) => {
  const f = await fixture(t);
  const changes: boolean[] = [];
  const { lastFrame, stdin, unmount } = mount(f, (value) => changes.push(value));
  await waitFor(lastFrame, /demo/);
  await key(stdin, "i");
  assert.equal(changes.at(-1), true);
  await key(stdin, ESC);
  await waitFor(lastFrame, /Install cancelled/);
  assert.equal(changes.at(-1), false);
  unmount();
});
