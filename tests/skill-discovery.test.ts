import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
