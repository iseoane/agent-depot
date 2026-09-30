import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectSkillSelection } from "../src/project-manifest.js";
import { SkillSelectionError, selectUserGlobalSkills } from "../src/skill-removal.js";

const record = (sourceId: string, skillPath: string): ProjectSkillSelection => ({
  source: sourceId === "builtin" ? { kind: "builtin", id: "builtin:agent-depot" } : { kind: "external", url: sourceId },
  path: skillPath,
  version: { policy: "latest" },
  hosts: ["pi"],
});

test("selectUserGlobalSkills treats duplicate exact paths as ambiguous", () => {
  const installations = [record("builtin", "portable/demo"), record("https://example.com/skills.git", "portable/demo")];

  assert.throws(
    () => selectUserGlobalSkills(installations, ["portable/demo"]),
    (error: unknown) => error instanceof SkillSelectionError && /Ambiguous user-global Skill "portable\/demo"/u.test(error.message),
  );
});

test("selectUserGlobalSkills resolves a unique exact path over same-named paths", () => {
  const installations = [record("builtin", "a/demo"), record("builtin", "demo")];

  assert.deepEqual(selectUserGlobalSkills(installations, ["demo"]), [installations[1]]);
});
