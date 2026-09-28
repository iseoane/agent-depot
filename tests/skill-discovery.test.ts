import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  discoverSkillsFromSources,
  NodeSourceContentAccess,
  parseSkillFrontmatter,
  type SourceContentAccess,
} from "../src/skill-discovery.js";
import type { Source } from "../src/sources.js";

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

test("does not traverse symbolic links in a package-owned built-in root", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-skills-"));
  try {
    await mkdir(path.join(directory, "real"));
    await writeFile(path.join(directory, "real", "SKILL.md"), "---\nname: Real\ndescription: Real\n---\n");
    try {
      await symlink(path.join(directory, "real"), path.join(directory, "linked"), "dir");
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
