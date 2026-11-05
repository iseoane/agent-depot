import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { render } from "ink-testing-library";

import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { defaultProjectManifestPath, ProjectManifestStore } from "../src/project-manifest.js";
import type { SkillCandidate } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";
import { App } from "../src/tui/app.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame, waitForSettled } from "./wait-for-frame.js";

const demo: SkillCandidate = { sourceId: BUILT_IN_SOURCE.id, path: "portable/demo", name: "demo", description: "Demo skill" };

interface Gate {
  /** While held, every call of the gated operation waits for `release`. */
  hold(): void;
  release(): void;
  wait(): Promise<void>;
}

function gate(): Gate {
  let holding = false;
  let open!: () => void;
  let opened = Promise.resolve();
  return {
    hold: () => {
      holding = true;
      opened = new Promise<void>(resolve => { open = resolve; });
    },
    release: () => {
      holding = false;
      open();
    },
    wait: () => (holding ? opened : Promise.resolve()),
  };
}

async function directories(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-retention-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-retention-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-tui-retention-state-"));
  t.after(async () => {
    await Promise.all([home, project, state].map(directory => rm(directory, { recursive: true, force: true })));
  });
  const environment: TuiEnvironment = {
    homeDirectory: home,
    projectRoot: project,
    projectManifestStore: new ProjectManifestStore(defaultProjectManifestPath(project)),
  };
  return { home, state, environment };
}

test("revisiting Catalog shows the last catalog at once, marked as refreshing, then the fresh one", async t => {
  const { home, state, environment } = await directories(t);
  const discovery = gate();
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = {
    ...real,
    discoverSkills: async () => {
      await discovery.wait();
      return [demo];
    },
  };
  const view = render(<App operations={operations} environment={environment} />);
  t.after(async () => {
    try {
      await waitForSettled(view.lastFrame);
    } finally {
      view.unmount();
    }
  });
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /Scope: all sources {2}1 of 1 Skills/);
  view.stdin.write("3");
  await waitForFrame(view.lastFrame, /▶ \[3\] Installations/);
  await waitForSettled(view.lastFrame);

  discovery.hold();
  view.stdin.write("2");
  const revisit = await waitForFrame(view.lastFrame, /▶ \[2\] Catalog/);
  assert.match(revisit, /Scope: all sources {2}1 of 1 Skills/, "the retained catalog is shown without waiting");
  assert.match(revisit, /Refreshing catalog/);
  assert.doesNotMatch(revisit, /Loading catalog/);
  discovery.release();
  const fresh = await waitForFrame(view.lastFrame, frame => /Scope: all sources/.test(frame) && !/Refreshing catalog/.test(frame));
  assert.match(fresh, /1 of 1 Skills/);
});

test("revisiting Installations shows the last list at once, marked as refreshing, then the fresh one", async t => {
  const { home, state, environment } = await directories(t);
  const listing = gate();
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = {
    ...real,
    listUserGlobalInstallations: async () => {
      await listing.wait();
      return real.listUserGlobalInstallations!();
    },
  };
  const view = render(<App operations={operations} environment={environment} />);
  t.after(async () => {
    try {
      await waitForSettled(view.lastFrame);
    } finally {
      view.unmount();
    }
  });
  view.stdin.write("3");
  await waitForFrame(view.lastFrame, /▶ \[3\] Installations/);
  await waitForSettled(view.lastFrame);
  view.stdin.write("2");
  await waitForFrame(view.lastFrame, /▶ \[2\] Catalog/);
  await waitForSettled(view.lastFrame);

  listing.hold();
  view.stdin.write("3");
  const revisit = await waitForFrame(view.lastFrame, /▶ \[3\] Installations/);
  assert.doesNotMatch(revisit, /Loading installations/);
  assert.match(revisit, /Refreshing installations/);
  listing.release();
  await waitForFrame(view.lastFrame, frame => /▶ \[3\] Installations/.test(frame) && !/Refreshing installations/.test(frame));
});

interface AppsFixture {
  readonly view: ReturnType<typeof render>;
  readonly runs: string[];
  /** Holds the next uninstall of `name` until the returned function is called. */
  holdUninstall(name: string): () => void;
  /** Holds the next resolution of `name`'s executable, as planning a step does. */
  holdResolve(name: string): () => void;
}

/** Two approved, installed Apps (`alpha`, `beta`); `failing` Apps fail their uninstall. */
async function appsFixture(t: TestContext, failing: readonly string[] = []): Promise<AppsFixture> {
  const { home, state, environment } = await directories(t);
  const recipes = path.join(state, "apps");
  await mkdir(recipes, { recursive: true });
  const names = ["alpha", "beta"] as const;
  for (const name of names) {
    await writeFile(path.join(recipes, `${name}.json`), JSON.stringify({
      name,
      install: { argv: [name, "install"] },
      update: { argv: [name, "update"] },
      uninstall: { argv: [name, "uninstall"] },
      version: { argv: [name, "--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    }));
  }
  const installed = new Set<string>();
  const runs: string[] = [];
  const uninstallHolds = new Map<string, Promise<void>>();
  const resolveHolds = new Map<string, Promise<void>>();
  const appEnvironment: AppEnvironment = {
    homeDirectory: home,
    recipesDirectory: recipes,
    resolveExecutable: async name => {
      await resolveHolds.get(name);
      return `/fake-bin/${name}`;
    },
    runner: async (executable, args) => {
      const name = path.posix.basename(executable);
      if (args[0] === "install") installed.add(name);
      if (args[0] === "--version") {
        return { code: installed.has(name) ? 0 : 1, signal: null, stdout: Buffer.from("1.0.0"), stderr: "", outputTooLarge: false };
      }
      if (args[0] === "uninstall") {
        runs.push(`${name} uninstall`);
        await uninstallHolds.get(name);
        if (failing.includes(name)) return { code: 2, signal: null, stdout: Buffer.alloc(0), stderr: "boom", outputTooLarge: false };
        installed.delete(name);
      }
      return { code: 0, signal: null, stdout: Buffer.from("done"), stderr: "", outputTooLarge: false };
    },
  };
  const apps = createAppOperations(appEnvironment);
  for (const entry of await apps.load()) {
    await apps.approve(entry);
    await apps.executeLifecycle(await apps.planLifecycle(entry, "install"), true);
  }
  const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const view = render(<App operations={operations} environment={{ ...environment, appEnvironment }} />);
  t.after(async () => {
    try {
      await waitForSettled(view.lastFrame);
    } finally {
      view.unmount();
    }
  });
  const hold = (holds: Map<string, Promise<void>>) => (name: string) => {
    let release!: () => void;
    holds.set(name, new Promise<void>(resolve => { release = () => { holds.delete(name); resolve(); }; }));
    return release;
  };
  return { view, runs, holdUninstall: hold(uninstallHolds), holdResolve: hold(resolveHolds) };
}

/** Opens Installations, expands the Apps group and marks every App in it. */
async function markBothApps(view: AppsFixture["view"]): Promise<void> {
  view.stdin.write("3");
  await waitForFrame(view.lastFrame, /Apps \(user-global\)/);
  for (let moves = 0; moves < 20; moves += 1) {
    const frame = view.lastFrame() ?? "";
    if ((frame.split("\n").find(line => line.includes("> ")) ?? "").includes("Apps (user-global)")) break;
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, next => next !== frame);
  }
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, /alpha {2}1\.0\.0[\s\S]*beta {2}1\.0\.0/);
  view.stdin.write("a");
  await waitForFrame(view.lastFrame, /2 Apps marked/);
}

for (const failing of [[], ["alpha"]] as const) {
  test(`a marked-App uninstall names each item and its position${failing.length ? ", and a failure keeps the rest going" : ""}`, async t => {
    const fixture = await appsFixture(t, failing);
    await markBothApps(fixture.view);
    const releaseAlpha = fixture.holdUninstall("alpha");
    fixture.view.stdin.write("u");
    await waitForFrame(fixture.view.lastFrame, /uninstall alpha\? y\/n/);
    fixture.view.stdin.write("y");
    await waitForFrame(fixture.view.lastFrame, /Running App step: alpha \(1\/2\)…/);

    const releaseBetaResolve = fixture.holdResolve("beta");
    releaseAlpha();
    const preparing = await waitForFrame(fixture.view.lastFrame, /Preparing App step: beta \(2\/2\)…/);
    assert.match(preparing, failing.length ? /alpha: failed/ : /alpha: \w+/, "the finished item stays visible");
    releaseBetaResolve();
    await waitForFrame(fixture.view.lastFrame, /uninstall beta\? y\/n/);

    const releaseBeta = fixture.holdUninstall("beta");
    fixture.view.stdin.write("y");
    const running = await waitForFrame(fixture.view.lastFrame, /Running App step: beta \(2\/2\)…/);
    assert.match(running, failing.length ? /alpha: failed/ : /alpha: \w+/);
    releaseBeta();
    const done = await waitForFrame(fixture.view.lastFrame, frame => /Result · /.test(frame) && !/(?:Running|Preparing) App step/.test(frame));
    assert.match(done, /alpha: /);
    assert.deepEqual(fixture.runs, ["alpha uninstall", "beta uninstall"]);
  });
}

test("a change made in Sources drops the retained Installations, so the revisit loads from scratch", async t => {
  const { home, state, environment } = await directories(t);
  const listing = gate();
  const real = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const operations: SourceOperations = {
    ...real,
    listUserGlobalInstallations: async () => {
      await listing.wait();
      return real.listUserGlobalInstallations!();
    },
  };
  const view = render(<App operations={operations} environment={environment} />);
  t.after(async () => {
    try {
      await waitForSettled(view.lastFrame);
    } finally {
      view.unmount();
    }
  });
  view.stdin.write("3");
  await waitForFrame(view.lastFrame, /Managed \(user-global\)/);
  view.stdin.write("1");
  await waitForFrame(view.lastFrame, /▶ \[1\] Sources/);
  await waitForSettled(view.lastFrame);
  // Adding a Source captures keys: from here on Sources may change what Installations describes.
  view.stdin.write("n");
  await waitForFrame(view.lastFrame, frame => /Add/i.test(frame) && !/q quit/.test(frame));
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, /q quit|n add/);

  listing.hold();
  view.stdin.write("3");
  const revisit = await waitForFrame(view.lastFrame, /▶ \[3\] Installations/);
  assert.match(revisit, /Loading installations/);
  listing.release();
  await waitForFrame(view.lastFrame, /Managed \(user-global\)/);
});
