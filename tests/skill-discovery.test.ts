import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultBuiltInSkillsRoot,
  discoverSkillsFromSources,
  NodeSourceContentAccess,
  parseSkillFrontmatter,
  type SourceContentAccess,
} from "../src/skill-discovery.js";
import { SKILL_TREE_LIMITS } from "../src/git-source.js";
import type { Source } from "../src/sources.js";
import { directoryLink } from "./link-helpers.js";

const builtin: Source = {
  id: "builtin:agent-depot",
  kind: "builtin",
  name: "Agent Depot",
  packageOwned: true,
};
const external: Source = {
  id: "git:1234567890abcdef12345678",
  kind: "git",
  url: "https://github.com/example/skills.git",
};

class FakeContentAccess implements SourceContentAccess {
  readonly requested: string[] = [];

  constructor(private readonly snapshots: ReadonlyMap<string, readonly { path: string; content: string }[]>) {}

  async readSnapshot(source: Source): Promise<readonly { path: string; content: string }[]> {
    this.requested.push(source.id);
    return this.snapshots.get(source.id) ?? [];
  }
}

test("discovers valid portable Skills recursively without selecting lifecycle subtrees", async () => {
  const access = new FakeContentAccess(new Map([
    [external.id, [
      { path: "zeta/SKILL.md", content: "---\nname: Zeta\ndescription: A zeta skill\n---\n" },
      { path: "beta/hidden/SKILL.md", content: "---\nname: Hidden\ndescription: Do not show\n---\n" },
      { path: "nested/retired/SKILL.md", content: "---\nname: Retired\ndescription: Do not show\n---\n" },
      { path: "alpha/SKILL.md", content: "---\nname: Alpha\ndescription: |\n  A multi-line\n  description.\n---\n" },
      { path: "invalid/SKILL.md", content: "# no frontmatter" },
      { path: "not-a-skill.txt", content: "---\nname: Nope\ndescription: Nope\n---\n" },
    ]],
  ]));

  assert.deepEqual(await discoverSkillsFromSources([external], access), [
    {
      sourceId: external.id,
      path: "alpha",
      name: "Alpha",
      description: "A multi-line\ndescription.",
    },
    {
      sourceId: external.id,
      path: "zeta",
      name: "Zeta",
      description: "A zeta skill",
    },
  ]);
  assert.deepEqual(access.requested, [external.id]);
});

test("parses quoted and folded required frontmatter fields and rejects incomplete metadata", () => {
  assert.deepEqual(parseSkillFrontmatter("\uFEFF---\nname: 'A ''quoted'' skill'\ndescription: >-\n  First line\n  second line\n---\n"), {
    name: "A 'quoted' skill",
    description: "First line second line",
  });
  assert.equal(parseSkillFrontmatter("---\nname: only-name\n---\n"), undefined);
  assert.equal(parseSkillFrontmatter("---\nname: skill\ndescription: text"), undefined);
  assert.equal(parseSkillFrontmatter("---\n  name: indented\ndescription: text\n---\n"), undefined);
});

test("skips nested block scalars inside a metadata mapping and rejects tabs within them", () => {
  const parsed = parseSkillFrontmatter("---\nname: Nested\ndescription: With nested block\nmetadata:\n  notes: |\n    first\n\n    second\n  folded: >-\n    text\n  other: value\n---\n");
  assert.deepEqual(parsed, { name: "Nested", description: "With nested block" });
  assert.equal(parseSkillFrontmatter("---\nname: Nested\ndescription: With nested block\nmetadata:\n  notes: |\n    first\n\tsecond\n---\n"), undefined);
});

test("accepts optional boolean metadata without weakening required fields", () => {
  assert.deepEqual(parseSkillFrontmatter("---\nname: Discoverable\ndescription: A discoverable skill\ndisable-model-invocation: true\n---\n"), {
    name: "Discoverable",
    description: "A discoverable skill",
  });
  assert.equal(parseSkillFrontmatter("---\nname: true\ndescription: A skill\n---\n"), undefined);
  assert.equal(parseSkillFrontmatter("---\nname: A skill\ndescription: false\n---\n"), undefined);
});

test("parses nested optional metadata without treating nested required fields as top-level", () => {
  const prSkill = `---
name: pr
description: Create a pull request from the current changes.
metadata:
  credits: Matt Pocock
---

# Pull requests
`;

  assert.deepEqual(parseSkillFrontmatter(prSkill), {
    name: "pr",
    description: "Create a pull request from the current changes.",
  });
  assert.equal(parseSkillFrontmatter("---\nmetadata:\n  name: nested\n  description: nested\n---\n"), undefined);
  assert.deepEqual(parseSkillFrontmatter("---\nname: Top-level\ndescription: Top-level description\nmetadata:\n  name: nested\n  description: nested\n---\n"), {
    name: "Top-level",
    description: "Top-level description",
  });
});

test("rejects malformed nested metadata indentation and values", () => {
  assert.equal(parseSkillFrontmatter("---\nname: Skill\ndescription: Description\nmetadata:\ncredits: outside\n---\n"), undefined);
  assert.equal(parseSkillFrontmatter("---\nname: Skill\ndescription: Description\nmetadata:\n  credits: [\n---\n"), undefined);
  assert.equal(parseSkillFrontmatter("---\nname: \ndescription: Description\nmetadata:\n  credits: valid\n---\n"), undefined);
});

test("discovers a real-shaped pr Skill with nested metadata", async () => {
  const access = new FakeContentAccess(new Map([
    [external.id, [{
      path: "skills/engineering/pr/SKILL.md",
      content: "---\nname: pr\ndescription: Create a pull request from the current changes.\nmetadata:\n  credits: Matt Pocock\n---\n",
    }]],
  ]));

  assert.deepEqual(await discoverSkillsFromSources([external], access), [{
    sourceId: external.id,
    path: "skills/engineering/pr",
    name: "pr",
    description: "Create a pull request from the current changes.",
  }]);
});

test("fails closed without throwing for deeply nested metadata", () => {
  const nestedMappings = Array.from({ length: 256 }, (_, depth) => `${" ".repeat(depth + 1)}level${depth}:`).join("\n");
  const content = `---\nname: Skill\ndescription: Description\nmetadata:\n${nestedMappings}\n---\n`;
  let result: ReturnType<typeof parseSkillFrontmatter>;

  assert.doesNotThrow(() => {
    result = parseSkillFrontmatter(content);
  });
  assert.equal(result, undefined);
});

test("reads only nested SKILL.md files and skips lifecycle subtrees before reading", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-skills-"));
  try {
    await writeFile(path.join(directory, "README.md"), "not a skill");
    await mkdir(path.join(directory, "nested", "inner"), { recursive: true });
    await writeFile(path.join(directory, "nested", "notes.txt"), "not a skill");
    await writeFile(path.join(directory, "nested", "SKILL.md"), "---\nname: Nested\ndescription: Nested skill\n---\n");
    await writeFile(path.join(directory, "nested", "inner", "SKILL.md"), "---\nname: Inner\ndescription: Inner skill\n---\n");
    await mkdir(path.join(directory, "deprecated", "hidden"), { recursive: true });
    await writeFile(path.join(directory, "deprecated", "hidden", "SKILL.md"), "---\nname: Hidden\ndescription: Hidden skill\n---\n");

    const readPaths: string[] = [];
    const access = new NodeSourceContentAccess({
      builtInRoot: directory,
      readFile: async (filePath) => {
        readPaths.push(filePath);
        return readFile(filePath, "utf8");
      },
    });

    assert.deepEqual(await access.readSnapshot(builtin), [
      {
        path: "nested/inner/SKILL.md",
        content: "---\nname: Inner\ndescription: Inner skill\n---\n",
      },
      {
        path: "nested/SKILL.md",
        content: "---\nname: Nested\ndescription: Nested skill\n---\n",
      },
    ]);
    assert.deepEqual(readPaths, [
      path.join(directory, "nested", "inner", "SKILL.md"),
      path.join(directory, "nested", "SKILL.md"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads a selected built-in Skill tree without changing discovery reads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-selected-skill-"));
  try {
    await mkdir(path.join(directory, "docs", "nested"), { recursive: true });
    await writeFile(path.join(directory, "docs", "SKILL.md"), "---\nname: Docs\ndescription: Docs skill\n---\n");
    await writeFile(path.join(directory, "docs", "README.md"), "supporting reference");
    await writeFile(path.join(directory, "docs", "nested", "example.txt"), "nested example");
    await mkdir(path.join(directory, "docs", "assets"), { recursive: true });
    await writeFile(path.join(directory, "docs", "assets", "image.bin"), Uint8Array.from([0x00, 0xff, 0x01, 0x80]));
    await mkdir(path.join(directory, "docs", "scripts"), { recursive: true });
    await writeFile(path.join(directory, "docs", "scripts", "check.sh"), Uint8Array.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0x00, 0xff]));
    await chmod(path.join(directory, "docs", "scripts", "check.sh"), 0o755);
    await writeFile(path.join(directory, "other", "SKILL.md"), "not selected").catch(async (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await mkdir(path.join(directory, "other"), { recursive: true });
        await writeFile(path.join(directory, "other", "SKILL.md"), "not selected");
        return;
      }
      throw error;
    });

    const readPaths: string[] = [];
    const access = new NodeSourceContentAccess({
      builtInRoot: directory,
      readBinaryFile: async (filePath) => {
        readPaths.push(filePath);
        return readFile(filePath);
      },
    });

    const files = await access.readSkillTree(builtin, "docs");
    assert.deepEqual(files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content),
      executable: file.executable,
    })), [
      { path: "docs/assets/image.bin", content: Buffer.from([0x00, 0xff, 0x01, 0x80]), executable: false },
      { path: "docs/nested/example.txt", content: Buffer.from("nested example"), executable: false },
      { path: "docs/README.md", content: Buffer.from("supporting reference"), executable: false },
      { path: "docs/scripts/check.sh", content: Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0x00, 0xff]), executable: process.platform !== "win32" /* no POSIX execute bit on Windows */ },
      { path: "docs/SKILL.md", content: Buffer.from("---\nname: Docs\ndescription: Docs skill\n---\n"), executable: false },
    ]);
    assert.deepEqual(readPaths, [
      path.join(directory, "docs", "assets", "image.bin"),
      path.join(directory, "docs", "nested", "example.txt"),
      path.join(directory, "docs", "README.md"),
      path.join(directory, "docs", "scripts", "check.sh"),
      path.join(directory, "docs", "SKILL.md"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects targeted built-in paths that could escape the Source root", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-selected-skill-"));
  try {
    await mkdir(path.join(directory, "skill"), { recursive: true });
    await writeFile(path.join(directory, "skill", "SKILL.md"), "skill");
    const access = new NodeSourceContentAccess({ builtInRoot: directory });

    await assert.rejects(access.readSkillTree(builtin, "../skill"), /traversal|unsafe/i);
    await assert.rejects(access.readSkillTree(builtin, "skill/../outside"), /traversal|unsafe/i);
    await assert.rejects(access.readSkillTree(builtin, "skill\\\\file"), /unsafe/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects symbolic links and oversized files in a selected built-in Skill tree", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-selected-skill-"));
  try {
    await mkdir(path.join(directory, "skill"), { recursive: true });
    await writeFile(path.join(directory, "skill", "SKILL.md"), "skill");
    try {
      await symlink(path.join(directory, "skill", "SKILL.md"), path.join(directory, "skill", "linked.md"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const access = new NodeSourceContentAccess({ builtInRoot: directory });
    await assert.rejects(access.readSkillTree(builtin, "skill"), /symbolic link/i);

    await rm(path.join(directory, "skill", "linked.md"));
    await writeFile(path.join(directory, "skill", "large.bin"), "x".repeat(SKILL_TREE_LIMITS.maxFileBytes + 1));
    await assert.rejects(access.readSkillTree(builtin, "skill"), /size limit/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not traverse symbolic links in a package-owned built-in root", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-skills-"));
  try {
    await mkdir(path.join(directory, "real"));
    await writeFile(path.join(directory, "real", "SKILL.md"), "---\nname: Real\ndescription: Real\n---\n");
    try {
      await directoryLink(path.join(directory, "real"), path.join(directory, "linked"));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }

    const access = new NodeSourceContentAccess({ builtInRoot: directory });
    assert.deepEqual(await discoverSkillsFromSources([builtin], access), [{
      sourceId: builtin.id,
      path: "real",
      name: "Real",
      description: "Real",
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default built-in root resolves to the package skills directory containing the doctor skills", async () => {
  const root = defaultBuiltInSkillsRoot();
  assert.equal(path.basename(root), "skills");
  for (const name of ["doctor-md-agents", "doctor-md-skill"]) {
    const manifest = await readFile(path.join(root, name, "SKILL.md"), "utf8");
    assert.match(manifest, new RegExp(`^---[\\s\\S]*name:\\s*"?${name}"?`, "m"));
  }
  assert.doesNotMatch(root.split(path.sep).join("/"), /\/dist\/skills$/);
  await readFile(path.join(path.dirname(root), "package.json"), "utf8");
});

test("reads the full tree of each shipped built-in skill, including large bundled assets", async () => {
  const access = new NodeSourceContentAccess();
  for (const name of ["doctor-md-agents", "doctor-md-skill"]) {
    const files = await access.readSkillTree(builtin, name);
    assert.ok(files.some((file) => file.path === `${name}/SKILL.md`));
  }
  const skillFiles = await access.readSkillTree(builtin, "doctor-md-skill");
  const bundle = skillFiles.find((file) => file.path.endsWith("assets/pierre-diffs.js"));
  assert.ok(bundle && bundle.content.byteLength > 1024 * 1024);
});

for (const totalMiB of [18, 32]) {
  test(`reads built-in Skill trees of ${totalMiB} MiB with byte preservation`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-large-skill-"));
    try {
      await mkdir(path.join(directory, "skill"));
      const content = Buffer.alloc(1024 * 1024, 0xa5);
      const paths = Array.from({ length: totalMiB }, (_, index) =>
        index === 0 ? "skill/SKILL.md" : `skill/asset-${index}.bin`);
      for (const filePath of paths) await writeFile(path.join(directory, filePath), content);
      const access = new NodeSourceContentAccess({ builtInRoot: directory });
      const files = await access.readSkillTree(builtin, "skill");
      assert.deepEqual(files.map((file) => file.path).sort(), [...paths].sort());
      assert.equal(files.reduce((total, file) => total + file.content.byteLength, 0), totalMiB * 1024 * 1024);
      for (const file of files) assert.deepEqual(Buffer.from(file.content), content);
      if (totalMiB === 32) {
        await writeFile(path.join(directory, "skill", "extra.bin"), Buffer.from([0xff]));
        await assert.rejects(access.readSkillTree(builtin, "skill"), /safe total size limit/i);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

const skillMd = (name: string, body = "") => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`;
const discoverPaths = async (files: readonly { path: string; content: string }[], source: Source = external) =>
  (await discoverSkillsFromSources([source], new FakeContentAccess(new Map([[source.id, files]])))).map((candidate) => candidate.path);

test("discovery ignores mirror directories of Hosts Agent Depot does not manage", async () => {
  const paths = await discoverPaths([
    { path: ".cursor/skills/a/SKILL.md", content: skillMd("a") },
    { path: ".gemini/skills/b/SKILL.md", content: skillMd("b") },
    { path: ".github/skills/c/SKILL.md", content: skillMd("c") },
    { path: ".trae-cn/skills/d/SKILL.md", content: skillMd("d") },
    { path: "cursor-plugin/skills/e/SKILL.md", content: skillMd("e") },
    { path: ".agents/skills/f/SKILL.md", content: skillMd("f") },
    { path: ".claude/skills/g/SKILL.md", content: skillMd("g") },
    { path: ".codex/skills/h/SKILL.md", content: skillMd("h") },
    { path: ".opencode/skills/i/SKILL.md", content: skillMd("i") },
    { path: ".pi/skills/j/SKILL.md", content: skillMd("j") },
    { path: "skills/.curated/k/SKILL.md", content: skillMd("k") },
  ]);
  assert.deepEqual(paths, [
    ".agents/skills/f",
    ".claude/skills/g",
    ".codex/skills/h",
    ".opencode/skills/i",
    ".pi/skills/j",
    "skills/.curated/k",
  ]);
});

test("discovery ignores test and fixture trees but keeps a Skill whose own directory is named test", async () => {
  const paths = await discoverPaths([
    { path: "tests/oracle/ctx-pin/.claude/skills/a/SKILL.md", content: skillMd("a") },
    { path: "test/b/SKILL.md", content: skillMd("b") },
    { path: "fixtures/c/SKILL.md", content: skillMd("c") },
    { path: "pkg/__tests__/d/SKILL.md", content: skillMd("d") },
    { path: "skills/test/SKILL.md", content: skillMd("test") },
    { path: "skills/e/SKILL.md", content: skillMd("e") },
  ]);
  assert.deepEqual(paths, ["skills/e", "skills/test"]);
});

test("discovery collapses identical Skills to one candidate with a deterministic canonical path", async () => {
  const same = skillMd("impeccable", "same body\n");
  const files = [
    { path: ".agents/skills/impeccable/SKILL.md", content: same },
    { path: ".claude/skills/impeccable/SKILL.md", content: same },
    { path: "plugin/skills/impeccable/SKILL.md", content: same },
    { path: "skills/other/SKILL.md", content: skillMd("other") },
  ];
  assert.deepEqual(await discoverPaths(files), ["plugin/skills/impeccable", "skills/other"]);
  assert.deepEqual(await discoverPaths([...files].reverse()), ["plugin/skills/impeccable", "skills/other"]);
  assert.deepEqual(await discoverPaths([
    { path: ".claude/skills/x/SKILL.md", content: same },
    { path: ".agents/skills/x/SKILL.md", content: same },
  ]), [".agents/skills/x"]);
});

test("discovery keeps same-named Skills whose content differs, and never collapses across Sources", async () => {
  assert.deepEqual(await discoverPaths([
    { path: "a/impeccable/SKILL.md", content: skillMd("impeccable", "one\n") },
    { path: "b/impeccable/SKILL.md", content: skillMd("impeccable", "two\n") },
  ]), ["a/impeccable", "b/impeccable"]);

  const other: Source = { id: "git:abcdef1234567890abcdef12", kind: "git", url: "https://github.com/example/other.git" };
  const access = new FakeContentAccess(new Map([
    [external.id, [{ path: "x/SKILL.md", content: skillMd("x") }]],
    [other.id, [{ path: "x/SKILL.md", content: skillMd("x") }]],
  ]));
  assert.equal((await discoverSkillsFromSources([external, other], access)).length, 2);
});

test("discovery keeps same-named Skills with identical SKILL.md but different supporting files in the snapshot", async () => {
  const same = skillMd("tool", "same\n");
  assert.deepEqual(await discoverPaths([
    { path: "a/tool/SKILL.md", content: same },
    { path: "a/tool/scripts/x", content: "one" },
    { path: "b/tool/SKILL.md", content: same },
    { path: "b/tool/scripts/x", content: "two" },
  ]), ["a/tool", "b/tool"]);
  assert.deepEqual(await discoverPaths([
    { path: ".claude/skills/tool/SKILL.md", content: same },
    { path: ".claude/skills/tool/scripts/x", content: "one" },
    { path: "plugin/skills/tool/SKILL.md", content: same },
    { path: "plugin/skills/tool/scripts/x", content: "one" },
  ]), ["plugin/skills/tool"]);
});

test("discovery compares whole Skill trees read from the Source when the snapshot carries only SKILL.md", async () => {
  const same = skillMd("tool", "same\n");
  const trees = new Map<string, string>([["a/tool", "one"], ["b/tool", "two"], ["c/tool", "one"]]);
  class TreeAccess extends FakeContentAccess {
    readSkillTree = async (_source: Source, skillPath: string) => [
      { path: `${skillPath}/SKILL.md`, content: new TextEncoder().encode(same), executable: false },
      { path: `${skillPath}/scripts/x`, content: new TextEncoder().encode(trees.get(skillPath)!), executable: false },
    ];
  }
  const access = new TreeAccess(new Map([[external.id, ["a", "b", "c"].map((dir) => ({ path: `${dir}/tool/SKILL.md`, content: same }))]]));
  assert.deepEqual((await discoverSkillsFromSources([external], access)).map((candidate) => candidate.path), ["a/tool", "b/tool"]);
});
