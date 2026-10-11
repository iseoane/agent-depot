import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderExpanded } from "./render-expanded.js";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";
import { defaultProjectManifestPath, ProjectManifestStore } from "../src/project-manifest.js";
import { createSourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const RECIPE = {
  name: "gentle-shell",
  platform: "linux",
  install: { argv: ["npm", "install", "-g", "gentle-shell"] },
  update: { argv: ["npm", "update", "-g", "gentle-shell"] },
  uninstall: { argv: ["npm", "uninstall", "-g", "gentle-shell"] },
  version: { argv: ["gentle-shell", "--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
};

for (const outcome of ["resolver", "spawn", "signal", "pattern"] as const) {
  test(`Catalog does not treat ${outcome} failures as proof that an App is absent`, async t => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-depot-catalog-unknown-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "agent-depot-catalog-unknown-project-"));
    const state = await mkdtemp(path.join(tmpdir(), "agent-depot-catalog-unknown-state-"));
    const recipesDirectory = path.join(state, "apps");
    await mkdir(recipesDirectory, { recursive: true });
    t.after(async () => Promise.all([home, project, state].map(directory => rm(directory, { recursive: true, force: true }))));
    const commands: string[] = [];
    const appEnvironment: AppEnvironment = {
      homeDirectory: home,
      recipesDirectory,
      resolveExecutable: async (name: string) => {
        if (name === "npm") return "/test-bin/npm";
        if (outcome === "resolver") throw new Error("resolver unavailable");
        return "/test-bin/unknown-app";
      },
      runner: async (_command: string, args: readonly string[]) => {
        commands.push(args.join(" "));
        if (outcome === "spawn") throw new Error("spawn failed");
        return {
          code: 0,
          signal: outcome === "signal" ? "SIGTERM" : null,
          stdout: Buffer.from(outcome === "pattern" ? "not a version" : "1.0.0"),
          stderr: "",
          outputTooLarge: false,
        };
      },
    };
    await writeFile(path.join(recipesDirectory, "unknown-app.json"), JSON.stringify({
      name: "unknown-app",
      install: { argv: ["npm", "install", "-g", "unknown-app"] },
      update: { argv: ["npm", "update", "-g", "unknown-app"] },
      uninstall: { argv: ["npm", "uninstall", "-g", "unknown-app"] },
      version: { argv: ["unknown-app", "--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
    }));
    const apps = createAppOperations(appEnvironment);
    const [entry] = await apps.load();
    await apps.approve(entry!);
    const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
    const view = await renderExpanded(<CatalogView operations={operations} environment={{ homeDirectory: home, projectRoot: project, appEnvironment }} />);
    t.after(() => view.unmount());
    const frame = await waitForFrame(view.lastFrame, /0 Apps/);
    assert.doesNotMatch(frame, /App unknown-app/);
    assert.ok(!commands.some(command => command.startsWith("npm install")));
  });
}

test("Catalog installs an approved App recipe only after preview confirmation", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-catalog-app-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-depot-catalog-app-project-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-catalog-app-state-"));
  const recipesDirectory = path.join(state, "apps");
  await mkdir(recipesDirectory, { recursive: true });
  t.after(async () => {
    await Promise.all([home, project, state].map(directory => rm(directory, { recursive: true, force: true })));
  });

  let installed = false;
  const commands: string[] = [];
  const appEnvironment = {
    homeDirectory: home,
    recipesDirectory,
    resolveExecutable: async (name: string) => name === "npm" || name === "missing-app" ? `/test-bin/${name}`
      : name === "gentle-shell" && installed ? "/test-bin/gentle-shell" : undefined,
    runner: async (command: string, args: readonly string[]) => {
      commands.push(`${path.basename(command)} ${args.join(" ")}`.trim());
      if (command.endsWith("/gentle-shell")) {
        return { code: installed ? 0 : 1, signal: null, stdout: Buffer.from(installed ? "1.2.3" : "not installed"), stderr: "", outputTooLarge: false };
      }
      if (command.endsWith("/npm") && args[0] === "install") {
        installed = true;
        return { code: 0, signal: null, stdout: Buffer.from("installed"), stderr: "", outputTooLarge: false };
      }
      throw new Error(`Unexpected recipe command: ${command} ${args.join(" ")}`);
    },
  };
  await writeFile(path.join(recipesDirectory, "gentle-shell.json"), JSON.stringify(RECIPE));
  await writeFile(path.join(recipesDirectory, "missing-app.json"), JSON.stringify({
    ...RECIPE,
    name: "missing-app",
    version: { argv: ["missing-app", "--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
  }));
  await writeFile(path.join(recipesDirectory, "needs-approval.json"), JSON.stringify({ ...RECIPE, name: "needs-approval" }));

  const apps = createAppOperations(appEnvironment);
  const entries = await apps.load();
  await apps.approve(entries.find(entry => entry.recipe?.name === "gentle-shell")!);
  await apps.approve(entries.find(entry => entry.recipe?.name === "missing-app")!);
  const operations = createSourceOperations({ statePath: path.join(state, "sources.json"), homeDirectory: home });
  const environment: TuiEnvironment = {
    homeDirectory: home,
    projectRoot: project,
    appEnvironment,
    projectManifestStore: new ProjectManifestStore(defaultProjectManifestPath(project)),
  };
  const view = await renderExpanded(
    <CatalogView operations={operations} environment={environment} />,
  );
  try {
    let frame = await waitForFrame(view.lastFrame, /Apps \(user-global\) \(1\)/);
    assert.doesNotMatch(frame, /missing-app|needs-approval/);
    assert.ok(!commands.some(command => command.startsWith("npm install")), "loading and preview do not install an App");

    for (let move = 0; move < 10 && !/^> [▸▾] Apps \(user-global\) \(1\)$/m.test(frame); move += 1) {
      view.stdin.write("j");
      frame = await waitForFrame(view.lastFrame, candidate => candidate !== frame);
    }
    assert.match(frame, /^> [▸▾] Apps \(user-global\) \(1\)$/m);
    if (/> ▸ Apps \(user-global\) \(1\)/.test(frame)) {
      view.stdin.write("\r");
      frame = await waitForFrame(view.lastFrame, /App gentle-shell {2}not installed/);
    }
    for (let move = 0; move < 3 && !/^>\s+App gentle-shell {2}not installed$/m.test(frame); move += 1) {
      view.stdin.write("j");
      frame = await waitForFrame(view.lastFrame, candidate => candidate !== frame);
    }
    assert.match(frame, /^>\s+App gentle-shell {2}not installed$/m);
    view.stdin.write("i");
    frame = await waitForFrame(view.lastFrame, /App install confirmation/);
    assert.match(frame, /argv: \["npm","install","-g","gentle-shell"\]/);
    assert.match(frame, /install gentle-shell\? y\/n/);
    assert.ok(!commands.some(command => command.startsWith("npm install")), "the preview is separate from execution");

    view.stdin.write("n");
    frame = await waitForFrame(view.lastFrame, /gentle-shell: cancelled/);
    assert.ok(!commands.some(command => command.startsWith("npm install")), "declining the preview must not install");
    view.stdin.write("i");
    frame = await waitForFrame(view.lastFrame, /App install confirmation/);
    assert.match(frame, /install gentle-shell\? y\/n/);
    view.stdin.write("y");
    frame = await waitForFrame(view.lastFrame, candidate => candidate.includes("gentle-shell: installed 1.2.3") && !/gentle-shell\s+not installed/.test(candidate));
    assert.match(frame, /Result · complete/);
    assert.equal((await apps.trackedApps()).find(record => record.name === "gentle-shell")?.installedVersion, "1.2.3");
    assert.ok(commands.some(command => command === "npm install -g gentle-shell"));
    assert.doesNotMatch(frame, /gentle-shell\s+not installed/);
  } finally {
    view.unmount();
  }
});
