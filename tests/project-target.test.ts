import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { AGENT_DEPOT_PACKAGE_VERSION } from "../src/project-manifest.js";
import { skillTreeBaseline, type SkillTreeFile } from "../src/skill-discovery.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../src/sources.js";
import { prepareInstall } from "../src/tui/catalog-installs.js";

const operations: SourceOperations = {
  async addGitSource() { throw new Error("unexpected"); },
  async listSources() { return [BUILT_IN_SOURCE]; },
  async refreshSource() { throw new Error("unexpected"); },
  async selectSources() { return [BUILT_IN_SOURCE]; },
};

const demoTree: readonly SkillTreeFile[] = [
  { path: "portable/demo/SKILL.md", content: Buffer.from("## D"), executable: false },
];
const demoVersion = { kind: "builtin-package" as const, version: AGENT_DEPOT_PACKAGE_VERSION! };

function sourceAccess(tree: readonly SkillTreeFile[], resolvedVersion = demoVersion) {
  return {
    async readSkillTree() { return tree; },
    async readSkillTreeSnapshot() { return { files: tree, resolvedVersion }; },
  };
}

async function tempDirectory(label: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `agent-depot-${label}-`)));
}

const installArguments = ["install", "--scope", "project", "--source", BUILT_IN_SOURCE.id, "--skill", "portable/demo", "--host", "pi", "--version", "latest", "--portable-v1"];

async function run(argv: readonly string[], extra: { projectRoot?: string } = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli(argv, {
    operations,
    sourceAccess: sourceAccess(demoTree),
    ...extra,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  return { code, output, errors };
}

const projectWarnings = (output: readonly string[]) => output.filter((line) => /^\s*WARNING: .*(Git repository|project manifest)/u.test(line));

test("a project install preview starts with the absolute project root", async () => {
  const root = await tempDirectory("target-first");
  try {
    const { code, output } = await run(installArguments, { projectRoot: root });
    assert.equal(code, 1);
    assert.equal(output[0], `Project: ${root}`);
    assert.match(output[1] ?? "", /^Preview: reconcile Skill/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project root defaults to the current working directory", async () => {
  const root = await tempDirectory("target-cwd");
  const previous = process.cwd();
  try {
    process.chdir(root);
    const { output } = await run(installArguments);
    assert.equal(output[0], `Project: ${process.cwd()}`);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("warns, without blocking, when the project root is inside a Git repository but not its top level", async () => {
  const top = await tempDirectory("target-git");
  try {
    await mkdir(path.join(top, ".git"));
    const sub = path.join(top, "packages", "app");
    await mkdir(sub, { recursive: true });

    const preview = await run(installArguments, { projectRoot: sub });
    const warning = preview.output.find((line) => /Git repository/u.test(line));
    assert.ok(warning?.includes(top), `the warning names the Git top level: ${warning}`);

    const installed = await run([...installArguments, "--yes"], { projectRoot: sub });
    assert.equal(installed.code, 0);
    assert.equal(await readFile(path.join(sub, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});

test("a Git worktree top level, marked by a .git file, gets no Git warning", async () => {
  const top = await tempDirectory("target-worktree");
  try {
    await writeFile(path.join(top, ".git"), "gitdir: elsewhere\n");
    await mkdir(path.join(top, ".claude"));
    const { output } = await run(installArguments, { projectRoot: top });
    assert.deepEqual(projectWarnings(output), []);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});

test("a brand-new project with no manifest and no Host directory warns but still installs", async () => {
  const root = await tempDirectory("target-empty");
  try {
    const preview = await run(installArguments, { projectRoot: root });
    assert.equal(projectWarnings(preview.output).length, 1);
    assert.match(projectWarnings(preview.output)[0]!, /agent-depot\.json/u);

    const installed = await run([...installArguments, "--yes"], { projectRoot: root });
    assert.equal(installed.code, 0);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing project manifest or a Host directory removes the empty-project warning", async () => {
  const withManifest = await tempDirectory("target-manifest");
  const withHostDirectory = await tempDirectory("target-host");
  try {
    await writeFile(path.join(withManifest, "agent-depot.json"), JSON.stringify({ version: 1, skills: [] }));
    await mkdir(path.join(withHostDirectory, ".codex"));
    for (const root of [withManifest, withHostDirectory]) {
      const { output } = await run(installArguments, { projectRoot: root });
      assert.equal(output[0], `Project: ${root}`);
      assert.deepEqual(projectWarnings(output), []);
    }
  } finally {
    await rm(withManifest, { recursive: true, force: true });
    await rm(withHostDirectory, { recursive: true, force: true });
  }
});

test("a manifest install preview starts with the project root", async () => {
  const root = await tempDirectory("target-manifest-install");
  try {
    await writeFile(path.join(root, "agent-depot.json"), JSON.stringify({
      version: 1,
      skills: [{ source: { kind: "builtin", id: BUILT_IN_SOURCE.id }, path: "portable/demo", version: { policy: "latest" }, hosts: ["pi"] }],
    }));
    const { code, output } = await run(["install", "--scope", "project", "--manifest", "--portable-v1"], { projectRoot: root });
    assert.equal(code, 1);
    assert.equal(output[0], `Project: ${root}`);
    assert.ok(output.some((line) => line.startsWith("Preview: reconcile Skill")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--project selects the project root and is resolved against the working directory", async () => {
  const parent = await tempDirectory("target-option");
  const project = path.join(parent, "chosen");
  const previous = process.cwd();
  try {
    await mkdir(project);
    process.chdir(parent);
    const preview = await run([...installArguments, "--project", "chosen"]);
    assert.equal(preview.output[0], `Project: ${project}`);
    assert.deepEqual(await readdir(project), [], "the preview writes nothing");

    const installed = await run([...installArguments, "--project", "chosen", "--yes"]);
    assert.equal(installed.code, 0);
    assert.equal(await readFile(path.join(project, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "## D");
    assert.ok(JSON.parse(await readFile(path.join(project, "agent-depot.json"), "utf8")).skills.length === 1);
  } finally {
    process.chdir(previous);
    await rm(parent, { recursive: true, force: true });
  }
});

test("--project rejects a missing path, a file and a user-global scope without writing", async () => {
  const parent = await tempDirectory("target-invalid");
  try {
    await writeFile(path.join(parent, "file.txt"), "x");
    const missing = await run([...installArguments, "--project", path.join(parent, "missing"), "--yes"]);
    assert.equal(missing.code, 1);
    assert.match(missing.errors.join("\n"), /--project .* does not exist/u);

    const file = await run([...installArguments, "--project", path.join(parent, "file.txt"), "--yes"]);
    assert.equal(file.code, 1);
    assert.match(file.errors.join("\n"), /--project .* is not a directory/u);

    const global = await run(["install", ...installArguments.slice(3), "--scope", "user-global", "--project", parent]);
    assert.equal(global.code, 1);
    assert.match(global.errors.join("\n"), /--project only applies to --scope project/u);

    assert.deepEqual((await readdir(parent)).sort(), ["file.txt"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function writeInstalledDemo(root: string, oldTree: readonly SkillTreeFile[]) {
  await mkdir(path.join(root, ".agents", "skills", "demo"), { recursive: true });
  await writeFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "old");
  await writeFile(path.join(root, "agent-depot.json"), JSON.stringify({
    version: 1,
    skills: [{
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/demo",
      version: { policy: "latest" },
      hosts: ["pi"],
      installation: {
        path: ".agents/skills/demo",
        adopted: false,
        resolvedVersion: { kind: "builtin-package", version: "0.0.1" },
        baseline: skillTreeBaseline(oldTree),
      },
    }],
  }));
}

test("update check and update apply previews name the project root; cancelling writes nothing", async () => {
  const root = await tempDirectory("target-update");
  const oldTree: readonly SkillTreeFile[] = [{ path: "portable/demo/SKILL.md", content: Buffer.from("old"), executable: false }];
  try {
    await writeInstalledDemo(root, oldTree);

    const check = await run(["update", "check", "--scope", "project", "--project", root]);
    assert.equal(check.code, 0);
    assert.equal(check.output[0], `Project: ${root}`);

    const apply = await run(["update", "apply", "--scope", "project", "--project", root, "--all"]);
    assert.equal(apply.code, 1);
    const previewIndex = apply.output.findIndex((line) => line.startsWith("Preview: update Skill"));
    assert.ok(previewIndex > 0, apply.output.join("\n"));
    assert.equal(apply.output[previewIndex - 1], `Project: ${root}`);
    assert.equal(await readFile(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the TUI install preview shows the project root and the user-global one does not", async () => {
  const root = await tempDirectory("target-tui");
  const home = await tempDirectory("target-tui-home");
  try {
    const environment = { projectRoot: root, homeDirectory: home, sourceAccess: sourceAccess(demoTree) };
    const skill = { sourceId: BUILT_IN_SOURCE.id, path: "portable/demo" } as Parameters<typeof prepareInstall>[2];
    const choice = { hosts: ["pi" as const], version: { policy: "latest" as const } };
    const project = await prepareInstall({ ...operations, async listUserGlobalInstallations() { return []; } }, environment, skill, { ...choice, scope: "project" });
    assert.equal(project.preview[0], `Project: ${root}`);
    const global = await prepareInstall({ ...operations, async listUserGlobalInstallations() { return []; }, async addUserGlobalInstallation() {} }, environment, skill, { ...choice, scope: "user-global" });
    assert.ok(!global.preview.some((line) => line.startsWith("Project:")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
