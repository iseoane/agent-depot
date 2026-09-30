import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { parseProjectManifest, ProjectManifestStore } from "../src/project-manifest.js";
import type { SkillCandidate } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const ESC = "\u001B";

/** Serves an empty project manifest so these tests never read the real cwd manifest. */
class EmptyManifestStore extends ProjectManifestStore {
  constructor() {
    super("/nonexistent/agent-depot-test/agent-depot.json");
  }

  override async load() {
    return parseProjectManifest({ version: 1, skills: [] });
  }
}
const NO_MANIFEST: TuiEnvironment = { projectManifestStore: new EmptyManifestStore() };

const skills: readonly SkillCandidate[] = [
  { sourceId: "builtin:agent-depot", path: "skills/alpha", name: "alpha", description: "Does Alpha things" },
  { sourceId: "builtin:agent-depot", path: "skills/beta", name: "beta", description: "Handles BETA work" },
  { sourceId: "git:1234567890abcdef12345678", path: "gamma", name: "gamma", description: "Something else" },
];

function operationsFor(discoverSkills?: SourceOperations["discoverSkills"]): SourceOperations {
  return {
    async addGitSource() {
      throw new Error("unused");
    },
    async listSources() {
      return [BUILT_IN_SOURCE, { id: "git:1234567890abcdef12345678", kind: "git" as const, url: "https://x/y.git" }];
    },
    async refreshSource() {
      throw new Error("unused");
    },
    async selectSources() {
      return [];
    },
    ...(discoverSkills ? { discoverSkills } : {}),
  };
}

function selectedLine(frame: string | undefined): string | undefined {
  return frame?.split("\n").find((line) => line.startsWith("> "));
}

test("CatalogView shows a loading state", () => {
  const { lastFrame, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(() => new Promise(() => undefined))} sourceId="builtin:agent-depot" />,
  );
  assert.match(lastFrame() ?? "", /Loading skills/);
  unmount();
});

test("CatalogView lists name, description and source id for the requested source", async () => {
  const requested: (readonly string[])[] = [];
  const { lastFrame, unmount } = render(
    <CatalogView environment={NO_MANIFEST}
      operations={operationsFor(async (ids) => {
        requested.push(ids);
        return skills.slice(0, 2);
      })}
      sourceId="builtin:agent-depot"
    />,
  );
  const frame = await waitForFrame(lastFrame, /2 of 2/);
  assert.deepEqual(requested, [["builtin:agent-depot"]]);
  assert.match(frame, /alpha\s+Does Alpha things\s+builtin:agent-depot/);
  assert.match(frame, /beta/);
  assert.match(frame, /2 of 2/);
  unmount();
});

test("CatalogView truncates long descriptions", async () => {
  const long = { ...skills[0], description: "x".repeat(200) };
  const { lastFrame, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => [long])} sourceId="builtin:agent-depot" />,
  );
  const frame = await waitForFrame(lastFrame, /x{20,}/);
  assert.ok(!frame.includes("x".repeat(100)));
  assert.match(frame, /x{20,}\.\.\./);
  unmount();
});

test("CatalogView shows empty, error and unsupported states", async () => {
  const empty = render(<CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => [])} sourceId="s" />);
  await waitForFrame(empty.lastFrame, /No skills/);
  empty.unmount();

  const failing = render(
    <CatalogView environment={NO_MANIFEST}
      operations={operationsFor(async () => {
        throw new Error("boom");
      })}
      sourceId="s"
    />,
  );
  await waitForFrame(failing.lastFrame, /Error: boom/);
  failing.unmount();

  const unsupported = render(<CatalogView environment={NO_MANIFEST} operations={operationsFor()} sourceId="s" />);
  await waitForFrame(unsupported.lastFrame, /not supported/);
  unsupported.unmount();
});

test("CatalogView navigates with j/k and arrows, clamped", async () => {
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => skills)} sourceId="builtin:agent-depot" />,
  );
  const selects = (name: RegExp) => waitForFrame(lastFrame, (frame) => name.test(selectedLine(frame) ?? ""));
  await selects(/alpha/);
  // Up at the top is clamped: if it moved the selection, "j" would land back on alpha instead of beta.
  stdin.write(UP);
  stdin.write("j");
  await selects(/beta/);
  stdin.write(DOWN);
  stdin.write(DOWN);
  stdin.write(DOWN);
  await selects(/gamma/);
  stdin.write("k");
  await selects(/beta/);
  unmount();
});

test("CatalogView filters case-insensitively on name and description with an n of m count", async () => {
  const capturing: boolean[] = [];
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST}
      operations={operationsFor(async () => skills)}
      sourceId="s"
      onCapturingChange={(value) => capturing.push(value)}
    />,
  );
  await waitForFrame(lastFrame, /3 of 3/);
  stdin.write("/");
  await waitForFrame(lastFrame, /Filter: _/);
  assert.equal(capturing.at(-1), true);
  stdin.write("beta");
  await waitForFrame(lastFrame, (frame) => /Filter: beta/.test(frame) && /1 of 3/.test(frame));
  assert.ok(!(lastFrame() ?? "").includes("alpha"));
  stdin.write("\r");
  await waitForFrame(lastFrame, (frame) => /Filter: beta(?!_)/.test(frame));
  assert.equal(capturing.at(-1), false);
  assert.match(lastFrame() ?? "", /1 of 3/);
  assert.match(lastFrame() ?? "", /beta/);

  stdin.write("/");
  await waitForFrame(lastFrame, /Filter: beta_/);
  stdin.write(ESC);
  await waitForFrame(lastFrame, /3 of 3/);
  assert.equal(capturing.at(-1), false);
  unmount();
});

test("CatalogView matches descriptions and shows no matches", async () => {
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => skills)} sourceId="s" />,
  );
  await waitForFrame(lastFrame, /3 of 3/);
  stdin.write("/");
  await waitForFrame(lastFrame, /Filter: _/);
  stdin.write("ALPHA T");
  await waitForFrame(lastFrame, /1 of 3/);
  stdin.write("zzz");
  await waitForFrame(lastFrame, /0 of 3.*No matching skills/s);
  unmount();
});

test("CatalogView toggles all sources with s", async () => {
  const requested: (readonly string[])[] = [];
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST}
      operations={operationsFor(async (ids) => {
        requested.push(ids);
        return skills;
      })}
      sourceId="builtin:agent-depot"
    />,
  );
  await waitForFrame(lastFrame, /3 of 3/);
  stdin.write("s");
  await waitForFrame(lastFrame, /all sources/);
  assert.deepEqual(requested.at(-1), ["builtin:agent-depot", "git:1234567890abcdef12345678"]);
  stdin.write("s");
  await waitForFrame(lastFrame, (frame) => !frame.includes("all sources") && /3 of 3/.test(frame));
  assert.deepEqual(requested.at(-1), ["builtin:agent-depot"]);
  unmount();
});

test("CatalogView starts on all sources when no source is given", async () => {
  const requested: (readonly string[])[] = [];
  const { lastFrame, unmount } = render(
    <CatalogView environment={NO_MANIFEST}
      operations={operationsFor(async (ids) => {
        requested.push(ids);
        return [];
      })}
    />,
  );
  await waitForFrame(lastFrame, /No skills/);
  assert.deepEqual(requested.at(-1), ["builtin:agent-depot", "git:1234567890abcdef12345678"]);
  unmount();
});
