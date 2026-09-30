import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "ink-testing-library";

import { parseProjectManifest, ProjectManifestStore, type ProjectSkillSelection } from "../src/project-manifest.js";
import type { SkillCandidate } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { waitForFrame } from "./wait-for-frame.js";

const DOWN = "\u001B[B";
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
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

function installedSelection(sourceId: string, skillPath: string): ProjectSkillSelection {
  const source = sourceId === BUILT_IN_SOURCE.id
    ? { kind: "builtin" as const, id: sourceId }
    : { kind: "external" as const, url: "https://x/y.git" };
  return parseProjectManifest({
    version: 1,
    skills: [{ source, path: skillPath, version: { policy: "latest" }, hosts: ["pi"] }],
  }).skills[0]!;
}

/** Manifest store serving the given project installations. */
function manifestWith(...skills: ProjectSkillSelection[]): TuiEnvironment {
  class Store extends ProjectManifestStore {
    constructor() {
      super("/nonexistent/agent-depot-test/agent-depot.json");
    }

    override async load() {
      return parseProjectManifest({ version: 1, skills });
    }
  }
  return { projectManifestStore: new Store() };
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

test("CatalogView lists skills as a tree under their source, with the installable count on the source", async () => {
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
  const lines = frame.split("\n");
  const group = lines.findIndex((line) => /▾ builtin:agent-depot \(2\)/.test(line));
  const alpha = lines.findIndex((line) => /alpha\s+Does Alpha things/.test(line));
  assert.ok(group >= 0 && alpha > group, `unexpected layout:\n${frame}`);
  assert.match(lines[alpha]!, /^\s{3,}alpha/, "skills are indented under their source");
  assert.ok(!lines[alpha]!.includes("builtin:agent-depot"), "the source is not repeated on each skill");
  assert.match(frame, /beta/);
  unmount();
});

test("CatalogView hides installed skills (user-global or project) and sources left with none", async () => {
  const operations: SourceOperations = {
    ...operationsFor(async () => skills),
    listUserGlobalInstallations: async () => [installedSelection("builtin:agent-depot", "skills/alpha")],
  };
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={manifestWith(installedSelection("builtin:agent-depot", "skills/beta"))} operations={operations} sourceId="s" />,
  );
  const frame = await waitForFrame(lastFrame, /1 of 1/);
  assert.ok(!frame.includes("alpha") && !frame.includes("beta"), "installed skills are not listed");
  assert.ok(!frame.includes("builtin:agent-depot"), "a source with no installable skills is hidden");
  assert.match(frame, /git:1234567890abcdef12345678 \(1\)/);
  stdin.write(DOWN);
  stdin.write(RIGHT);
  await waitForFrame(lastFrame, /gamma/);
  unmount();
});

test("CatalogView says so when every skill is installed", async () => {
  const operations: SourceOperations = {
    ...operationsFor(async () => skills.slice(0, 1)),
    listUserGlobalInstallations: async () => [installedSelection("builtin:agent-depot", "skills/alpha")],
  };
  const { lastFrame, unmount } = render(<CatalogView environment={NO_MANIFEST} operations={operations} sourceId="s" />);
  const frame = await waitForFrame(lastFrame, /All skills are installed/);
  assert.ok(!frame.includes("alpha"));
  unmount();
});

test("CatalogView truncates long descriptions", async () => {
  const long = { ...skills[0], description: "x".repeat(200) };
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => [long])} sourceId="builtin:agent-depot" />,
  );
  await waitForFrame(lastFrame, /1 of 1/);
  stdin.write(RIGHT);
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

test("CatalogView navigates the tree with j/k and arrows, clamped, and expands or collapses sources", async () => {
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => skills)} sourceId="builtin:agent-depot" />,
  );
  const selects = (name: RegExp) => waitForFrame(lastFrame, (frame) => name.test(selectedLine(frame) ?? ""));
  await selects(/builtin:agent-depot/);
  // Up at the top is clamped: if it moved the selection, "j" would land back on the source instead of alpha.
  stdin.write(UP);
  stdin.write("j");
  await selects(/alpha/);
  stdin.write(DOWN);
  await selects(/beta/);
  stdin.write(DOWN);
  await selects(/git:1234567890abcdef12345678/);
  assert.ok(!(lastFrame() ?? "").includes("gamma"), "the second source starts collapsed");
  stdin.write(RIGHT);
  await waitForFrame(lastFrame, /gamma/);
  stdin.write("j");
  await selects(/gamma/);
  stdin.write(LEFT);
  await selects(/git:1234567890abcdef12345678/);
  stdin.write(LEFT);
  await waitForFrame(lastFrame, (frame) => !frame.includes("gamma"));
  stdin.write("\r");
  await waitForFrame(lastFrame, /gamma/);
  unmount();
});

test("CatalogView filters leaves case-insensitively, keeps their sources and shows an n of m count", async () => {
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
  stdin.write("gamma");
  const filtered = await waitForFrame(lastFrame, (frame) => /Filter: gamma/.test(frame) && /1 of 3/.test(frame));
  assert.match(filtered, /git:1234567890abcdef12345678 \(1\)/, "the parent of a match stays visible and opens");
  assert.match(filtered, /gamma/);
  assert.ok(!filtered.includes("alpha") && !filtered.includes("builtin:agent-depot"));
  stdin.write("\r");
  await waitForFrame(lastFrame, (frame) => /Filter: gamma(?!_)/.test(frame));
  assert.equal(capturing.at(-1), false);
  assert.match(lastFrame() ?? "", /1 of 3/);

  stdin.write("/");
  await waitForFrame(lastFrame, /Filter: gamma_/);
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

class ReceiverBoundOperations implements SourceOperations {
  async addGitSource(): Promise<never> {
    throw new Error("unused");
  }

  async listSources() {
    return [BUILT_IN_SOURCE];
  }

  async refreshSource(): Promise<never> {
    throw new Error("unused");
  }

  async selectSources(ids: readonly string[]) {
    return (await this.listSources()).filter((source) => ids.includes(source.id));
  }

  // Like the real operations, this relies on `this`; a detached call loses it.
  async discoverSkills(ids: readonly string[]): Promise<readonly SkillCandidate[]> {
    await this.selectSources(ids);
    return skills.filter((skill) => ids.includes(skill.sourceId));
  }
}

test("CatalogView calls discoverSkills with its receiver", async () => {
  const { lastFrame, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={new ReceiverBoundOperations()} sourceId="builtin:agent-depot" />,
  );
  const frame = await waitForFrame(lastFrame, /alpha|Cannot read properties/);
  assert.doesNotMatch(frame, /Cannot read properties/);
  assert.match(frame, /alpha/);
  unmount();
});

test("CatalogView windows a long tree around the highlight and pages with PgUp/PgDn", async () => {
  const many: readonly SkillCandidate[] = Array.from({ length: 40 }, (_, n) => ({
    sourceId: "builtin:agent-depot",
    path: `skills/s${String(n).padStart(2, "0")}`,
    name: `skill${String(n).padStart(2, "0")}`,
    description: "d",
  }));
  const { lastFrame, stdin, unmount } = render(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => many)} sourceId="builtin:agent-depot" listHeight={6} />,
  );
  const top = await waitForFrame(lastFrame, /1–6 of 41/);
  assert.match(selectedLine(top) ?? "", /builtin:agent-depot/);
  assert.ok(!top.includes("skill06"));
  stdin.write("\u001B[6~");
  const paged = await waitForFrame(lastFrame, (frame) => /skill05/.test(selectedLine(frame) ?? ""));
  assert.match(paged, /\d+–\d+ of 41/);
  stdin.write("\u001B[5~");
  await waitForFrame(lastFrame, (frame) => /builtin:agent-depot/.test(selectedLine(frame) ?? ""));
  unmount();
});
