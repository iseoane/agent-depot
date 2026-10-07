import assert from "node:assert/strict";
import { test } from "node:test";

import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { Children, isValidElement, type ReactNode } from "react";
import { renderExpanded } from "./render-expanded.js";

import { parseProjectManifest, ProjectManifestStore, type ProjectSkillSelection } from "../src/project-manifest.js";
import { packageSelectionFor, type BundleDescriptor } from "../src/package-model.js";
import type { SkillCandidate } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { NO_INSTALLED } from "../src/tui/catalog-installs.js";
import { CatalogRowLine, CatalogSelectionHelp } from "../src/tui/catalog-panel.js";
import type { NodeData } from "../src/tui/catalog-tree.js";
import { CatalogView } from "../src/tui/catalog-view.js";
import type { TuiEnvironment } from "../src/tui/environment.js";
import { theme } from "../src/tui/theme.js";
import type { VisibleRow } from "../src/tui/tree.js";
import { fakePackageOperations } from "./fake-package-operations.js";
import { waitForFrame } from "./wait-for-frame.js";

const DOWN = "\u001B[B";
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
const UP = "\u001B[A";
const ESC = "\u001B";
const ENTER = "\r";

/** Serves an empty project manifest so these tests never read the real cwd manifest. */
class EmptyManifestStore extends ProjectManifestStore {
  constructor() {
    super("/nonexistent/agent-depot-test/agent-depot.json");
  }

  override async load() {
    return parseProjectManifest({ version: 1, skills: [] });
  }
}
const NO_PACKAGES = fakePackageOperations();
const NO_MANIFEST: TuiEnvironment = { projectManifestStore: new EmptyManifestStore(), packages: NO_PACKAGES };

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
  return { projectManifestStore: new Store(), packages: NO_PACKAGES };
}

function selectedLine(frame: string | undefined): string | undefined {
  return frame?.split("\n").find((line) => line.startsWith("> "));
}

async function moveToSelected(lastFrame: () => string | undefined, stdin: { write(data: string): void }, pattern: RegExp): Promise<string> {
  for (let moves = 0; moves < 20; moves += 1) {
    const line = selectedLine(lastFrame()) ?? "";
    if (pattern.test(line)) return lastFrame() ?? "";
    const before = lastFrame();
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => frame !== before);
  }
  assert.fail(`selection never matched ${String(pattern)}; frame:\n${lastFrame() ?? ""}`);
}

function packageDescriptor(host: "pi" | "claude", name: string, pathPrefix: string): BundleDescriptor {
  return {
    host,
    coordinates: host === "pi"
      ? { host, root: pathPrefix.replace(/\/skills$/u, "") }
      : { host, marketplaceRoot: pathPrefix.replace(/\/skills$/u, ""), pluginName: name },
    name,
    version: { kind: "manifest-version", version: "1.2.0", declaredBy: "bundle" },
    components: [{
      kind: "skills", ownership: "skill-category", effect: "instruction",
      paths: [pathPrefix], skillNames: ["create-verification-skill"],
    }],
    warnings: [],
    installable: true,
    manifestDigest: host === "pi" ? "a".repeat(64) : "b".repeat(64),
  };
}

function hasTextColor(node: ReactNode, color: string): boolean {
  return Children.toArray(node).some((child) => {
    if (!isValidElement<{ readonly color?: string; readonly children?: ReactNode }>(child)) return false;
    return child.props.color === color || hasTextColor(child.props.children, color);
  });
}

function ownedSkillRow(overrides: Partial<SkillCandidate> = {}, owner = packageDescriptor("pi", "pstack", "plugins/pstack/skills")): VisibleRow<NodeData> {
  const skill: SkillCandidate = {
    sourceId: "git:pstack",
    path: "plugins/pstack/skills/create-verification-skill",
    name: "create-verification-skill",
    description: "Generate a project-local verification skill that drives your app the way a user does",
    ...overrides,
  };
  return {
    depth: 1,
    parentId: "source:git:pstack",
    expandable: false,
    expanded: false,
    node: { id: `skill:${skill.sourceId}:${skill.path}`, data: { kind: "skill", skill, ownedBy: owner } },
  };
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
  const { lastFrame, unmount } = await renderExpanded(
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
  assert.match(lines[alpha]!, /^\s{3,}\[ \] alpha/, "skills are indented under their source");
  assert.ok(!lines[alpha]!.includes("builtin:agent-depot"), "the source is not repeated on each skill");
  assert.match(frame, /beta/);
  unmount();
});

test("CatalogView hides installed skills (user-global or project) and sources left with none", async () => {
  const operations: SourceOperations = {
    ...operationsFor(async () => skills),
    listUserGlobalInstallations: async () => [installedSelection("builtin:agent-depot", "skills/alpha")],
  };
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={manifestWith(installedSelection("builtin:agent-depot", "skills/beta"))} operations={operations} sourceId="s" />,
  );
  const frame = await waitForFrame(lastFrame, /1 of 1/);
  assert.ok(!frame.includes("alpha") && !frame.includes("beta"), "installed skills are not listed");
  assert.ok(!frame.includes("builtin:agent-depot"), "a source with no installable skills is hidden");
  assert.match(frame, /x\/y \(1\)/);
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
  const { lastFrame, unmount } = await renderExpanded(<CatalogView environment={NO_MANIFEST} operations={operations} sourceId="s" />);
  const frame = await waitForFrame(lastFrame, /All skills are installed/);
  assert.ok(!frame.includes("alpha"));
  unmount();
});

test("CatalogRowLine keeps Package-owned rows to one physical terminal line", async () => {
  for (const width of [80, 120, 40]) {
    const view = render(<Box width={width}><CatalogRowLine row={ownedSkillRow()} selected={false} marked={false} installed={NO_INSTALLED} /></Box>);
    try {
      const frame = await waitForFrame(view.lastFrame, /create-verification-skill/);
      assert.equal(frame.split("\n").length, 1, `width ${width} wrapped:\n${frame}`);
    } finally {
      view.unmount();
    }
  }
});

test("CatalogRowLine remains one line after a narrow resize with unicode and unmanaged markers", async () => {
  const unicode = ownedSkillRow({
    path: "plugins/pstack/skills/超级长技能名字超级长技能名字",
    name: "超级长技能名字超级长技能名字",
    description: "说明".repeat(80),
  });
  const installed = { ...NO_INSTALLED, unmanagedNames: new Set(["超级长技能名字超级长技能名字"]) };
  const view = render(<Box width={120}><CatalogRowLine row={unicode} selected={false} marked={false} installed={installed} /></Box>);
  try {
    await waitForFrame(view.lastFrame, /超级长技能/);
    view.rerender(<Box width={40}><CatalogRowLine row={unicode} selected={false} marked={false} installed={installed} /></Box>);
    const narrow = await waitForFrame(view.lastFrame, /超级长技能/);
    assert.equal(narrow.split("\n").length, 1, `narrow row wrapped:\n${narrow}`);
  } finally {
    view.unmount();
  }
});

test("Catalog ownership details keep a fixed Ink panel height across loose and long Unicode owners", async () => {
  const pi = packageDescriptor("pi", "pstack-界🚀", "plugins/pi/skills");
  const claude = packageDescriptor("claude", "claude-owner-with-a-long-name", "plugins/claude/skills");
  const rows = [
    ownedSkillRow({}, pi),
    ownedSkillRow({}, claude),
    { ...ownedSkillRow(), node: { id: "skill:loose", data: { kind: "skill" as const, skill: { sourceId: "s", path: "loose", name: "loose", description: "Loose Skill" } } } },
  ];
  const renderPanel = (index: number) => render(
    <Box flexDirection="column" width={40}>
      <Text>1–5 of 30</Text>
      {Array.from({ length: 5 }, (_, row) => <Text key={row}>{row === 2 ? "> selected" : `  row ${row}`}</Text>)}
      <CatalogSelectionHelp row={rows[index]} height={6} />
      <Text>footer</Text>
    </Box>,
  );
  const view = renderPanel(0);
  try {
    const baseline = await waitForFrame(view.lastFrame, /footer/);
    for (const index of [1, 2]) {
      view.rerender(
        <Box flexDirection="column" width={40}>
          <Text>1–5 of 30</Text>
          {Array.from({ length: 5 }, (_, row) => <Text key={row}>{row === 2 ? "> selected" : `  row ${row}`}</Text>)}
          <CatalogSelectionHelp row={rows[index]} height={6} />
          <Text>footer</Text>
        </Box>,
      );
      const frame = await waitForFrame(view.lastFrame, /footer/);
      assert.equal(frame.split("\n").length, baseline.split("\n").length);
      assert.equal(frame.split("\n").indexOf("1–5 of 30"), baseline.split("\n").indexOf("1–5 of 30"));
      assert.equal(frame.split("\n").indexOf("footer"), baseline.split("\n").indexOf("footer"));
    }
    assert.match(baseline, /Package-owned Skill: provided by the pi[\s\S]*pstack-界🚀/);
  } finally {
    view.unmount();
  }
});

test("Package-owned Catalog row text keeps readable contrast", () => {
  const element = CatalogRowLine({ row: ownedSkillRow(), selected: false, marked: false, installed: NO_INSTALLED });
  if (!isValidElement<{ readonly color?: string; readonly children?: ReactNode }>(element)) assert.fail("CatalogRowLine returned no Text element");
  assert.notEqual(element.props.color, theme.inactive);
  assert.ok(hasTextColor(element.props.children, theme.marker), "the compact Package badge uses the marker colour");
});

test("CatalogView truncates long descriptions", async () => {
  const long = { ...skills[0], description: "x".repeat(200) };
  const { lastFrame, stdin, unmount } = await renderExpanded(
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
  const empty = await renderExpanded(<CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => [])} sourceId="s" />);
  await waitForFrame(empty.lastFrame, /No skills/);
  empty.unmount();

  const failing = await renderExpanded(
    <CatalogView environment={NO_MANIFEST}
      operations={operationsFor(async () => {
        throw new Error("boom");
      })}
      sourceId="s"
    />,
  );
  await waitForFrame(failing.lastFrame, /Source s unavailable: boom/);
  assert.match(failing.lastFrame() ?? "", /refresh it with r/);
  failing.unmount();

  const unsupported = await renderExpanded(<CatalogView environment={NO_MANIFEST} operations={operationsFor()} sourceId="s" />);
  await waitForFrame(unsupported.lastFrame, /not supported/);
  unsupported.unmount();
});

test("CatalogView navigates the tree with j/k and arrows, clamped, and expands or collapses sources", async () => {
  const { lastFrame, stdin, unmount } = await renderExpanded(
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
  await selects(/x\/y/);
  assert.ok(!(lastFrame() ?? "").includes("gamma"), "the second source starts collapsed");
  stdin.write(RIGHT);
  await waitForFrame(lastFrame, /gamma/);
  stdin.write("j");
  await selects(/gamma/);
  stdin.write(LEFT);
  await selects(/x\/y/);
  stdin.write(LEFT);
  await waitForFrame(lastFrame, (frame) => !frame.includes("gamma"));
  stdin.write("\r");
  await waitForFrame(lastFrame, /gamma/);
  unmount();
});

test("CatalogView filter keeps pasted text that starts like an escape remnant", async () => {
  const { lastFrame, stdin, unmount } = await renderExpanded(<CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => skills)} sourceId="s" />);
  await waitForFrame(lastFrame, /3 of 3/);
  stdin.write("/");
  await waitForFrame(lastFrame, /Filter: _/);
  stdin.write("OK");
  await waitForFrame(lastFrame, /Filter: OK/);
  unmount();
});

test("CatalogView filters leaves case-insensitively, keeps their sources and shows an n of m count", async () => {
  const capturing: boolean[] = [];
  const { lastFrame, stdin, unmount } = await renderExpanded(
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
  assert.match(filtered, /x\/y \(1\)/, "the parent of a match stays visible and opens");
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
  const { lastFrame, stdin, unmount } = await renderExpanded(
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

test("CatalogView a toggles only the highlighted repository and preserves marks in other repositories", async () => {
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => skills)} />,
  );
  try {
    await waitForFrame(lastFrame, /3 of 3/);
    stdin.write("a");
    await waitForFrame(lastFrame, /2 selected/);
    const marked = lastFrame();
    stdin.write("a");
    await waitForFrame(lastFrame, (frame) => frame !== marked && !frame.includes("selected"));

    stdin.write("a");
    await waitForFrame(lastFrame, /2 selected/);
    await moveToSelected(lastFrame, stdin, /x\/y/);
    stdin.write("a");
    await waitForFrame(lastFrame, /3 selected/);
    stdin.write("kkk");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("builtin:agent-depot") === true);
    const firstRepository = lastFrame() ?? "";
    assert.match(firstRepository, /alpha/);
    assert.match(firstRepository.split("\n").find((line) => line.includes("alpha")) ?? "", /\[x\] alpha/);
    assert.match(firstRepository.split("\n").find((line) => line.includes("beta")) ?? "", /\[x\] beta/);
  } finally {
    unmount();
  }
});

test("CatalogView a leaves filtered-out marks alone", async () => {
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={NO_MANIFEST} operations={operationsFor(async () => skills.slice(0, 2))} sourceId="builtin:agent-depot" />,
  );
  try {
    await waitForFrame(lastFrame, /2 of 2/);
    await waitForFrame(lastFrame, /alpha/);
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("alpha") === true);
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("beta") === true);
    stdin.write(" ");
    await waitForFrame(lastFrame, /1 selected/);

    stdin.write("/");
    await waitForFrame(lastFrame, /Filter: _/);
    stdin.write("alpha");
    await waitForFrame(lastFrame, /Filter: alpha/);
    stdin.write("\r");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("builtin:agent-depot") === true);
    stdin.write("a");
    await waitForFrame(lastFrame, /1 selected/);
    stdin.write(ESC);
    await waitForFrame(lastFrame, /2 of 2/);
    stdin.write(ENTER);
    const unfiltered = await waitForFrame(lastFrame, (frame) => frame.includes("alpha") && frame.includes("beta"));
    assert.match(unfiltered.split("\n").find((line) => line.includes("alpha")) ?? "", /\[x\] alpha/);
    assert.match(unfiltered.split("\n").find((line) => line.includes("beta")) ?? "", /\[x\] beta/);
  } finally {
    unmount();
  }
});

test("CatalogView a resolves the repository from Source, group, Package, and Skill rows", async () => {
  const source = { id: "git:pstack", kind: "git" as const, url: "https://github.com/iseoane/pstack.git" };
  const descriptor = packageDescriptor("pi", "pstack", "plugins/pstack/skills");
  const operations: SourceOperations = {
    ...operationsFor(async () => [{ sourceId: source.id, path: "loose/skill", name: "loose", description: "Loose skill" }]),
    async listSources() { return [source]; },
  };
  const packages = fakePackageOperations({ discover: async () => [descriptor] });
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={{ ...NO_MANIFEST, packages }} operations={operations} />,
  );
  try {
    await waitForFrame(lastFrame, /iseoane\/pstack \(1\)/);
    await waitForFrame(lastFrame, /Packages \(1\)/);
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("Packages (1)") === true);
    stdin.write("a");
    await waitForFrame(lastFrame, /1 selected/);
    stdin.write(ENTER);
    await waitForFrame(lastFrame, /Package pstack \(pi\)/);
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("Package pstack") === true);
    stdin.write("a");
    await waitForFrame(lastFrame, (frame) => !frame.includes("1 selected"));
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("loose") === true);
    stdin.write("a");
    await waitForFrame(lastFrame, /1 selected/);
  } finally {
    unmount();
  }
});

test("CatalogView a excludes active Package-owned skills", async () => {
  const source = { id: "git:pstack", kind: "git" as const, url: "https://github.com/iseoane/pstack.git" };
  const descriptor = packageDescriptor("pi", "pstack", "plugins/pstack/skills");
  const owned = { sourceId: source.id, path: "plugins/pstack/skills/create-verification-skill", name: "create-verification-skill", description: "Owned" };
  const loose = { sourceId: source.id, path: "loose/skill", name: "loose", description: "Loose" };
  const operations: SourceOperations = {
    ...operationsFor(async () => [owned, loose]),
    async listSources() { return [source]; },
  };
  const packages = fakePackageOperations({
    discover: async () => [descriptor],
    activeBundles: async () => [{ descriptor, selection: packageSelectionFor(descriptor, { kind: "external", url: source.url }), reason: "selected" }],
  });
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={{ ...NO_MANIFEST, packages }} operations={operations} />,
  );
  try {
    await waitForFrame(lastFrame, /iseoane\/pstack \(2\)/);
    stdin.write("a");
    const marked = await waitForFrame(lastFrame, /1 selected/);
    assert.match(marked.split("\n").find((line) => line.includes("loose")) ?? "", /\[x\] loose/);
    assert.match(marked.split("\n").find((line) => line.includes("create-verification-skill")) ?? "", /\[ \] create-verification-skill/);
  } finally {
    unmount();
  }
});

test("CatalogView toggles all sources with s", async () => {
  const requested: (readonly string[])[] = [];
  const { lastFrame, stdin, unmount } = await renderExpanded(
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
  const { lastFrame, unmount } = await renderExpanded(
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
  const { lastFrame, unmount } = await renderExpanded(
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
  const { lastFrame, stdin, unmount } = await renderExpanded(
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


test("CatalogView keeps healthy Sources browsable when a Git mirror is unavailable", async () => {
  let refreshes = 0;
  const missingId = "git:1234567890abcdef12345678";
  const operations: SourceOperations = {
    ...operationsFor(async (ids) => {
      if (ids.includes(missingId)) throw new Error("Git Source mirror is not available: /cache/missing");
      return skills.slice(0, 2);
    }),
    async refreshSource() { refreshes++; throw new Error("must not refresh automatically"); },
  };
  const { lastFrame, stdin, unmount } = await renderExpanded(<CatalogView environment={NO_MANIFEST} operations={operations} />);
  try {
    const frame = await waitForFrame(lastFrame, /2 of 2/);
    assert.match(frame, /mirror is not available/);
    assert.match(frame, /refresh it with r/);
    assert.match(frame, /alpha/);
    assert.match(frame, /beta/);
    stdin.write("j");
    await waitForFrame(lastFrame, (value) => /alpha/.test(selectedLine(value) ?? ""));
    assert.equal(refreshes, 0);
  } finally { unmount(); }
});


test("CatalogView shows repository names rather than Git IDs", async () => {
  const source = { id: "git:1234567890abcdef12345678", kind: "git" as const, url: "https://github.com/cursor/plugins/tree/main/pstack" };
  const operations: SourceOperations = {
    ...operationsFor(async () => [skills[2]]),
    async listSources() { return [source]; },
  };
  const { lastFrame, unmount } = await renderExpanded(<CatalogView environment={NO_MANIFEST} operations={operations} />);
  try {
    const frame = await waitForFrame(lastFrame, /cursor\/plugins · pstack @ main \(1\)/);
    assert.ok(!frame.includes(source.id));
  } finally { unmount(); }
});


test("CatalogView lists a Source's bundles and marks the Skills they own", async () => {
  const source = { id: "git:1234567890abcdef12345678", kind: "git" as const, url: "https://github.com/iseoane/pstack.git" };
  const pi: BundleDescriptor = {
    host: "pi",
    coordinates: { host: "pi", root: "plugins/pstack" },
    name: "pstack",
    version: { kind: "manifest-version", version: "1.2.0", declaredBy: "bundle" },
    components: [{
      kind: "skills", ownership: "skill-category", effect: "instruction",
      paths: ["plugins/pstack/skills"], skillNames: ["how"],
    }],
    warnings: [],
    installable: true,
    manifestDigest: "a".repeat(64),
  };
  const claude: BundleDescriptor = {
    ...pi,
    host: "claude",
    coordinates: { host: "claude", marketplaceRoot: "plugins/pstack", pluginName: "pstack" },
    version: undefined,
  };
  const operations: SourceOperations = {
    ...operationsFor(async () => [
      { sourceId: source.id, path: "plugins/pstack/skills/how", name: "how", description: "How skill" },
      { sourceId: source.id, path: "plugins/loose/loose", name: "loose", description: "Loose skill" },
    ]),
    async listSources() { return [source]; },
  };
  const packages = fakePackageOperations({ discover: async () => [pi, claude] });
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={{ ...NO_MANIFEST, packages }} operations={operations} />,
  );
  try {
    await waitForFrame(lastFrame, /iseoane\/pstack \(2\)/);
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => frame.split("\n").some((line) => line.startsWith("> ") && line.includes("Packages (2)")));
    stdin.write(ENTER);
    const frame = await waitForFrame(lastFrame, /Package pstack \(pi\) {2}1\.2\.0/);
    assert.match(frame, /Package pstack \(pi\) {2}1\.2\.0/);
    assert.match(frame, /Package pstack \(claude\) {2}unknown/);
    const looseLine = frame.split("\n").find((line) => line.includes("loose")) ?? "";
    assert.ok(!looseLine.includes("provided by"), "a loose Skill is never marked as bundle-owned");
  } finally {
    unmount();
  }
});


test("CatalogView hides only the exact host-proven installed bundle", async () => {
  const source = { id: "git:pstack", kind: "git" as const, url: "https://github.com/iseoane/pstack.git" };
  const pi = packageDescriptor("pi", "pstack-pi", "plugins/pi/skills");
  const claude = packageDescriptor("claude", "pstack-claude", "plugins/claude/skills");
  const operations: SourceOperations = {
    ...operationsFor(async () => []),
    async listSources() { return [source]; },
  };
  const packages = fakePackageOperations({
    discover: async () => [pi, claude],
    activeBundles: async () => [
      { descriptor: pi, selection: packageSelectionFor(pi, { kind: "external", url: source.url }), reason: "selected" },
      { descriptor: claude, selection: packageSelectionFor(claude, { kind: "external", url: source.url }), reason: "installed" },
    ],
  });
  const { lastFrame, stdin, unmount } = await renderExpanded(
    <CatalogView environment={{ ...NO_MANIFEST, packages }} operations={operations} />,
  );
  try {
    await waitForFrame(lastFrame, /Packages \(1\)/u);
    stdin.write("j");
    await waitForFrame(lastFrame, (frame) => selectedLine(frame)?.includes("Packages (1)") === true);
    stdin.write(ENTER);
    const frame = await waitForFrame(lastFrame, /Package pstack-pi \(pi\)/u);
    assert.match(frame, /Package pstack-pi \(pi\)/u);
    assert.doesNotMatch(frame, /Package pstack-claude \(claude\)/u);
  } finally {
    unmount();
  }
});

test("CatalogView keeps Package rows reachable and explains owned Skills without enabling loose install", async () => {
  const source = { id: "git:pstack", kind: "git" as const, url: "https://github.com/iseoane/pstack.git" };
  const pi = packageDescriptor("pi", "pstack-pi", "plugins/pi/skills");
  const claude = packageDescriptor("claude", "pstack-claude", "plugins/claude/skills");
  const catalogSkills: readonly SkillCandidate[] = [
    { sourceId: source.id, path: "plugins/pi/skills/create-verification-skill", name: "create-verification-skill", description: "Generate a project-local verification skill that drives your app the way a user does" },
    { sourceId: source.id, path: "plugins/claude/skills/poteto-mode", name: "poteto-mode", description: "poteto's agent style for concise, detailed responses" },
  ];
  const operations: SourceOperations = {
    ...operationsFor(async () => catalogSkills),
    async listSources() { return [source]; },
  };
  const packages = fakePackageOperations({
    discover: async () => [pi, claude],
    activeBundles: async () => [
      { descriptor: pi, selection: packageSelectionFor(pi, { kind: "external", url: source.url }), reason: "selected" },
      { descriptor: claude, selection: packageSelectionFor(claude, { kind: "external", url: source.url }), reason: "selected" },
    ],
  });
  const tree = <CatalogView environment={{ ...NO_MANIFEST, packages }} operations={operations} />;
  const view = await renderExpanded(tree);
  const { lastFrame, stdin, stdout, unmount } = view;
  Object.defineProperty(stdout, "columns", { configurable: true, value: 40 });
  Object.defineProperty(stdout, "rows", { configurable: true, value: 16 });
  view.rerender(tree);
  try {
    await moveToSelected(lastFrame, stdin, /Packages \(2\)/);
    stdin.write(ENTER);
    await waitForFrame(lastFrame, /Package pstack-pi \(pi\) {2}1\.2\.0/);
    await moveToSelected(lastFrame, stdin, /Package pstack-pi \(pi\)/);
    await moveToSelected(lastFrame, stdin, /Package pstack-claude \(claude\)/);
    await moveToSelected(lastFrame, stdin, /create-verification-skill/);
    const owned = await waitForFrame(lastFrame, /provided by the pi\s+Package pstack-pi/);
    assert.ok(owned.split("\n").length + 4 <= 15, `selection help exceeded the 16-row terminal with shell chrome:\n${owned}`);
    assert.match(selectedLine(owned) ?? "", /create-verification-skill/);
    assert.doesNotMatch(selectedLine(owned) ?? "", /provided by the pi Package/);
    assert.match(owned, /Install or update the\s+Package from its Package row/);
    stdin.write(" ");
    const markRefusal = await waitForFrame(lastFrame, /Package-owned Skills cannot be marked/);
    assert.doesNotMatch(markRefusal, /1 selected/);
    stdin.write("i");
    const installRefusal = await waitForFrame(lastFrame, /Install or update the pi Package\s+pstack-pi/);
    assert.doesNotMatch(installRefusal, /Host \(space\/1-4 toggle/);
  } finally {
    unmount();
  }
});


test("CatalogView starts collapsed, expands on demand, and opens filter matches", async () => {
  const operations = operationsFor(async () => skills);
  const { lastFrame, stdin, unmount } = render(<CatalogView environment={NO_MANIFEST} operations={operations} />);
  try {
    const frame = await waitForFrame(lastFrame, /3 of 3/);
    assert.match(frame, /▸ builtin:agent-depot \(2\)/);
    assert.match(frame, /▸ x\/y \(1\)/);
    assert.doesNotMatch(frame, /alpha|beta|gamma/);
    stdin.write("\r");
    await waitForFrame(lastFrame, /alpha/);
    stdin.write("\r");
    await waitForFrame(lastFrame, (text) => !text.includes("alpha"));
    stdin.write("/");
    await waitForFrame(lastFrame, /Filter: _/);
    stdin.write("gamma");
    const filtered = await waitForFrame(lastFrame, /▾ x\/y \(1\)/);
    assert.match(filtered, /gamma.*Something else/);
    stdin.write(ESC);
    const reset = await waitForFrame(lastFrame, /3 of 3/);
    assert.doesNotMatch(reset, /alpha|beta|gamma/);
  } finally { unmount(); }
});
