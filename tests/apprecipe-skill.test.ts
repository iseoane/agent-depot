import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { parseAppRecipe } from "../src/app-recipes.js";
import { defaultBuiltInSkillsRoot, parseSkillFrontmatter } from "../src/skill-discovery.js";
import { createSourceOperations } from "../src/sources.js";

const name = "agent-depot-apprecipe";
const skillFile = path.join(defaultBuiltInSkillsRoot(), name, "SKILL.md");

test("discovers the built-in App recipe skill with valid frontmatter and installs it through the CLI", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "apprecipe-skill-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const candidates = await operations.discoverSkills(["builtin:agent-depot"]);
  const candidate = candidates.find((item) => item.name === name);
  assert.ok(candidate, "App recipe skill must be in the built-in Source");
  assert.equal(candidate.path, name);
  const markdown = await readFile(skillFile, "utf8");
  assert.deepEqual(parseSkillFrontmatter(markdown), { name, description: candidate.description });
  const output: string[] = [];
  assert.equal(await runCli([
    "install", "--source", "builtin:agent-depot", "--skill", name,
    "--scope", "user-global", "--host", "pi", "--version", "latest", "--portable-v1", "--yes",
  ], { operations, homeDirectory: home, projectRoot: home, stdout: (line) => output.push(line), stderr: (line) => output.push(line) }), 0, output.join("\n"));
  assert.equal(await readFile(path.join(home, ".agents", "skills", name, "SKILL.md"), "utf8"), markdown);
});

test("every JSON recipe example bundled with the App recipe skill passes the real parser", async () => {
  const root = path.dirname(skillFile);
  const documents = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".md"));
  const markdown = (await Promise.all(documents.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  const examples = [...markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)];
  assert.ok(examples.length > 0, "keep a parser-checked recipe example");
  for (const [index, example] of examples.entries()) {
    assert.doesNotThrow(() => parseAppRecipe(JSON.parse(example[1]!)), `recipe example ${index + 1}`);
  }
});
