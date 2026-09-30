import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import type { SkillCandidate } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const ESC = "\u001B";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

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
    <CatalogView operations={operationsFor(() => new Promise(() => undefined))} sourceId="builtin:agent-depot" />,
  );
  assert.match(lastFrame() ?? "", /Loading skills/);
  unmount();
});

test("CatalogView lists name, description and source id for the requested source", async () => {
  const requested: (readonly string[])[] = [];
  const { lastFrame, unmount } = render(
    <CatalogView
      operations={operationsFor(async (ids) => {
        requested.push(ids);
        return skills.slice(0, 2);
      })}
      sourceId="builtin:agent-depot"
    />,
  );
  await tick();
  const frame = lastFrame() ?? "";
  assert.deepEqual(requested, [["builtin:agent-depot"]]);
  assert.match(frame, /alpha\s+Does Alpha things\s+builtin:agent-depot/);
  assert.match(frame, /beta/);
  assert.match(frame, /2 of 2/);
  unmount();
});

test("CatalogView truncates long descriptions", async () => {
  const long = { ...skills[0], description: "x".repeat(200) };
  const { lastFrame, unmount } = render(
    <CatalogView operations={operationsFor(async () => [long])} sourceId="builtin:agent-depot" />,
  );
  await tick();
  const frame = lastFrame() ?? "";
  assert.ok(!frame.includes("x".repeat(100)));
  assert.match(frame, /x{20,}\.\.\./);
  unmount();
});

test("CatalogView shows empty, error and unsupported states", async () => {
  const empty = render(<CatalogView operations={operationsFor(async () => [])} sourceId="s" />);
  await tick();
  assert.match(empty.lastFrame() ?? "", /No skills/);
  empty.unmount();

  const failing = render(
    <CatalogView
      operations={operationsFor(async () => {
        throw new Error("boom");
      })}
      sourceId="s"
    />,
  );
  await tick();
  assert.match(failing.lastFrame() ?? "", /Error: boom/);
  failing.unmount();

  const unsupported = render(<CatalogView operations={operationsFor()} sourceId="s" />);
  await tick();
  assert.match(unsupported.lastFrame() ?? "", /not supported/);
  unsupported.unmount();
});

test("CatalogView navigates with j/k and arrows, clamped", async () => {
  const { lastFrame, stdin, unmount } = render(
    <CatalogView operations={operationsFor(async () => skills)} sourceId="builtin:agent-depot" />,
  );
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /alpha/);
  stdin.write(UP);
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /alpha/);
  stdin.write("j");
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /beta/);
  stdin.write(DOWN);
  stdin.write(DOWN);
  stdin.write(DOWN);
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /gamma/);
  stdin.write("k");
  await tick();
  assert.match(selectedLine(lastFrame()) ?? "", /beta/);
  unmount();
});

test("CatalogView filters case-insensitively on name and description with an n of m count", async () => {
  const capturing: boolean[] = [];
  const { lastFrame, stdin, unmount } = render(
    <CatalogView
      operations={operationsFor(async () => skills)}
      sourceId="s"
      onCapturingChange={(value) => capturing.push(value)}
    />,
  );
  await tick();
  stdin.write("/");
  await tick();
  assert.equal(capturing.at(-1), true);
  stdin.write("beta");
  await tick();
  assert.match(lastFrame() ?? "", /Filter: beta/);
  assert.match(lastFrame() ?? "", /1 of 3/);
  assert.ok(!(lastFrame() ?? "").includes("alpha"));
  stdin.write("\r");
  await tick();
  assert.equal(capturing.at(-1), false);
  assert.match(lastFrame() ?? "", /1 of 3/);
  assert.match(lastFrame() ?? "", /beta/);

  stdin.write("/");
  await tick();
  stdin.write(ESC);
  await tick();
  assert.match(lastFrame() ?? "", /3 of 3/);
  assert.equal(capturing.at(-1), false);
  unmount();
});

test("CatalogView matches descriptions and shows no matches", async () => {
  const { lastFrame, stdin, unmount } = render(
    <CatalogView operations={operationsFor(async () => skills)} sourceId="s" />,
  );
  await tick();
  stdin.write("/");
  await tick();
  stdin.write("ALPHA T");
  await tick();
  assert.match(lastFrame() ?? "", /1 of 3/);
  stdin.write("zzz");
  await tick();
  assert.match(lastFrame() ?? "", /0 of 3/);
  assert.match(lastFrame() ?? "", /No matching skills/);
  unmount();
});

test("CatalogView toggles all sources with s", async () => {
  const requested: (readonly string[])[] = [];
  const { lastFrame, stdin, unmount } = render(
    <CatalogView
      operations={operationsFor(async (ids) => {
        requested.push(ids);
        return skills;
      })}
      sourceId="builtin:agent-depot"
    />,
  );
  await tick();
  stdin.write("s");
  await tick();
  assert.deepEqual(requested.at(-1), ["builtin:agent-depot", "git:1234567890abcdef12345678"]);
  assert.match(lastFrame() ?? "", /all sources/);
  stdin.write("s");
  await tick();
  assert.deepEqual(requested.at(-1), ["builtin:agent-depot"]);
  unmount();
});

test("CatalogView starts on all sources when no source is given", async () => {
  const requested: (readonly string[])[] = [];
  const { unmount } = render(
    <CatalogView
      operations={operationsFor(async (ids) => {
        requested.push(ids);
        return [];
      })}
    />,
  );
  await tick();
  assert.deepEqual(requested.at(-1), ["builtin:agent-depot", "git:1234567890abcdef12345678"]);
  unmount();
});
