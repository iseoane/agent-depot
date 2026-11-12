import assert from "node:assert/strict";
import { test } from "node:test";

import type { SkillUpdatePlan } from "../src/skill-update.js";
import { describeUpdatePreview } from "../src/update-flow.js";

// describeUpdatePreview reads only these fields; the rest of a real plan does not affect the text.
function plan(overrides: Partial<Pick<SkillUpdatePlan, "nonCanonicalPath" | "overwriteRequired" | "methodPreview">> = {}): SkillUpdatePlan {
  return {
    selection: { path: "skills/tdd" },
    source: { id: "git:acme" },
    snapshot: { files: [{}, {}, {}, {}] },
    target: "/repo/.agents/skills/tdd",
    overwriteRequired: false,
    ...overrides,
  } as unknown as SkillUpdatePlan;
}

const everything = plan({
  nonCanonicalPath: "/repo/tools/skills/tdd",
  overwriteRequired: true,
  methodPreview: {
    argv: ["make", "install skill"],
    cwd: "/repo",
    target: "/repo/tools/skills/tdd",
    declaredChanges: ["writes tools/skills/tdd", "touches cache"],
    warning: "runs a repository-controlled command",
  },
});

test("the CLI update preview text stays byte-identical with the confirmation flags", () => {
  assert.deepEqual(describeUpdatePreview(plan(), "user-global", "/repo"), [
    'Preview: update Skill "skills/tdd" from git:acme (scope: user-global)',
    "  target: /repo/.agents/skills/tdd",
    "  proposed changes: replace 4 managed files and persist the new version/content baseline",
  ]);
  assert.deepEqual(describeUpdatePreview(everything, "project", "/repo", "flags"), [
    'Preview: update Skill "skills/tdd" from git:acme (scope: project)',
    "  target: /repo/.agents/skills/tdd",
    '  WARNING: non-canonical location "tools/skills/tdd" (outside .agents/skills and .claude/skills); --yes together with --confirm-path tools/skills/tdd explicitly confirms replacing this exact path',
    "  proposed changes: replace 4 managed files and persist the new version/content baseline",
    "  WARNING: the installed Skill has local modifications; --yes explicitly confirms replacing them",
    '  external command: argv=["make","install skill"]',
    '  external cwd: "/repo"',
    '  external target: "/repo/tools/skills/tdd"',
    "  declared changes:",
    "    writes tools/skills/tdd",
    "    touches cache",
    "  WARNING: runs a repository-controlled command",
  ]);
});

test("the interactive update preview text names the prompts instead of the flags", () => {
  assert.deepEqual(describeUpdatePreview(everything, "project", "/repo", "prompt"), [
    'Preview: update Skill "skills/tdd" from git:acme (scope: project)',
    "  target: /repo/.agents/skills/tdd",
    '  WARNING: non-canonical location "tools/skills/tdd" (outside .agents/skills and .claude/skills); a separate confirmation of this exact path is required to replace it',
    "  proposed changes: replace 4 managed files and persist the new version/content baseline",
    "  WARNING: the installed Skill has local modifications; confirming replaces them",
    '  external command: argv=["make","install skill"]',
    '  external cwd: "/repo"',
    '  external target: "/repo/tools/skills/tdd"',
    "  declared changes:",
    "    writes tools/skills/tdd",
    "    touches cache",
    "  WARNING: runs a repository-controlled command",
  ]);
});

test("an external method without cwd and without declared changes prints no cwd line and an empty declared-changes header", () => {
  const bare = plan({
    methodPreview: {
      argv: ["make", "install skill"],
      target: "/repo/.agents/skills/tdd",
      declaredChanges: [],
      warning: "runs a repository-controlled command",
    } as unknown as SkillUpdatePlan["methodPreview"], // the type always carries cwd; the renderer still omits the line without one
  });
  assert.deepEqual(describeUpdatePreview(bare, "user-global", "/repo"), [
    'Preview: update Skill "skills/tdd" from git:acme (scope: user-global)',
    "  target: /repo/.agents/skills/tdd",
    "  proposed changes: replace 4 managed files and persist the new version/content baseline",
    '  external command: argv=["make","install skill"]',
    '  external target: "/repo/.agents/skills/tdd"',
    "  declared changes:",
    "  WARNING: runs a repository-controlled command",
  ]);
});
