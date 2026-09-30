import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

/**
 * Characterization of the built CLI end to end. Everything lives in one temporary
 * sandbox: HOME, XDG_* and the global git configuration all point inside it, and
 * the Source URL is rewritten to a local file:// repository, so no network access
 * and no real user state is touched. The cases share the sandbox and run in order.
 */

const cliPath = path.resolve("dist/src/cli.js");
const sourceUrl = "https://example.test/src/source.git";

let sandbox = "";
let home = "";
let sourceRepo = "";
let env: NodeJS.ProcessEnv = {};
let sourceId = "";
let firstCommit = "";
let firstAlphaDigest = "";

interface CliResult {
  readonly status: number | null;
  readonly output: string;
}

function cli(cwd: string, ...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function ok(result: CliResult): string {
  assert.equal(result.status, 0, result.output);
  return result.output;
}

function fails(result: CliResult, pattern: RegExp): void {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, pattern);
}

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${body}\n`;
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

async function makeProject(name: string): Promise<string> {
  const directory = path.join(sandbox, name);
  await mkdir(directory, { recursive: true });
  git(directory, "init", "-q");
  return directory;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function manifest(project: string): Promise<{ skills: Array<{ installation: { path: string; adopted: boolean; baseline: { digest: string } } }> }> {
  return JSON.parse(await readFile(path.join(project, "agent-depot.json"), "utf8"));
}

function installArgs(scope: "project" | "user-global", skill: string, ...hosts: string[]): string[] {
  return [
    "install", "--source", sourceId, "--version", "latest", "--portable-v1", "--scope", scope,
    "--skill", `skills/${skill}`, ...hosts.flatMap((host) => ["--host", host]),
  ];
}

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "agent-depot-e2e-"));
  home = path.join(sandbox, "home");
  sourceRepo = path.join(sandbox, "source");
  await Promise.all(["home", "state", "config", "cache", "source"].map((name) => mkdir(path.join(sandbox, name), { recursive: true })));
  const gitConfig = path.join(sandbox, "gitconfig");
  await writeFile(
    gitConfig,
    `[url "file://${sourceRepo}"]\n\tinsteadOf = ${sourceUrl}\n[protocol "file"]\n\tallow = always\n`,
  );
  env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: path.join(sandbox, "state"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.test",
    GIT_COMMITTER_NAME: "e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.test",
  };
  git(sourceRepo, "init", "-q", "-b", "main");
  await writeFiles(sourceRepo, {
    "skills/alpha/SKILL.md": skillMarkdown("alpha", "Alpha skill", "Alpha v1"),
    "skills/alpha/refs/notes.md": "support v1\n",
    "skills/gamma/SKILL.md": skillMarkdown("gamma", "Gamma skill", "Gamma v1"),
    "skills/gamma/helper.txt": "gamma support\n",
  });
  git(sourceRepo, "add", "-A");
  git(sourceRepo, "commit", "-qm", "v1");
  firstCommit = git(sourceRepo, "rev-parse", "HEAD");
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("agent-depot end to end lifecycle (hermetic)", () => {
  let project = "";

  test("registers, refreshes and discovers a Git Source", async () => {
    project = await makeProject("project");
    assert.equal(ok(cli(project, "source", "list")).trim(), "builtin:agent-depot\tbuiltin\tAgent Depot\tread-only");

    const added = ok(cli(project, "source", "add", sourceUrl));
    const match = /git:[0-9a-f]+/.exec(added);
    assert.ok(match, added);
    sourceId = match[0];
    assert.match(ok(cli(project, "source", "list")), new RegExp(`${sourceId}\\tgit\\t${sourceUrl.replaceAll(".", "\\.")}`));

    fails(cli(project, "source", "refresh", sourceId), /Refresh not confirmed; rerun with --yes/);
    assert.match(ok(cli(project, "source", "refresh", sourceId, "--yes")), /Refreshed Git Source/);

    const discovered = ok(cli(project, "discover", sourceId));
    assert.match(discovered, /skills\/alpha\talpha\tAlpha skill/);
    assert.match(discovered, /skills\/gamma\tgamma\tGamma skill/);
    assert.equal(ok(cli(project, "discover", "builtin:agent-depot")).trim(), "");

    fails(cli(project, "discover", "git:000000000000000000000000"), /Source is not registered/);
    fails(
      cli(project, "install", "--source", "git:000000000000000000000000", "--version", "latest", "--portable-v1", "--scope", "project", "--skill", "skills/alpha", "--host", "pi", "--yes"),
      /Source is not registered/,
    );
  });

  test("installs project Skills with a canonical directory, Claude symlink and manifest", async () => {
    const args = installArgs("project", "alpha", "claude", "pi");
    fails(cli(project, ...args), /Installation not confirmed; rerun with --yes/);
    assert.equal(await exists(path.join(project, ".agents")), false);
    assert.equal(await exists(path.join(project, "agent-depot.json")), false);

    ok(cli(project, ...args, "--yes"));
    assert.match(await readFile(path.join(project, ".agents/skills/alpha/SKILL.md"), "utf8"), /Alpha v1/);
    assert.equal(await readFile(path.join(project, ".agents/skills/alpha/refs/notes.md"), "utf8"), "support v1\n");
    assert.equal(await readlink(path.join(project, ".claude/skills/alpha")), "../../.agents/skills/alpha");
    const saved = await manifest(project);
    assert.equal(saved.skills.length, 1);
    assert.equal(saved.skills[0]?.installation.path, ".agents/skills/alpha");
    assert.equal(saved.skills[0]?.installation.adopted, false);
    firstAlphaDigest = saved.skills[0]?.installation.baseline.digest ?? "";
    assert.match(firstAlphaDigest, /^[0-9a-f]{64}$/);

    fails(cli(project, ...args, "--yes"), /already managed Skills? must be changed with update apply|already managed Sk/);
    ok(cli(project, ...installArgs("project", "gamma", "pi"), "--yes"));
    assert.match(ok(cli(project, "update", "check", "--scope", "project")), /Updateable \(0\):\nCurrent \(2\):/);
    fails(cli(project, ...installArgs("project", "nope", "pi"), "--yes"), /does not contain skills\/nope\/SKILL\.md/);
  });

  test("installs a user-global Skill without reporting Agent Depot's own symlink as skipped", async () => {
    const args = installArgs("user-global", "alpha", "claude");
    ok(cli(project, ...args, "--yes"));
    assert.match(await readFile(path.join(home, ".agents/skills/alpha/SKILL.md"), "utf8"), /Alpha v1/);
    assert.equal(await readlink(path.join(home, ".claude/skills/alpha")), "../../.agents/skills/alpha");
    fails(cli(project, ...args, "--yes"), /already recorded in user-global state/);

    const check = ok(cli(project, "update", "check", "--scope", "user-global"));
    assert.match(check, /Current \(1\):/);
    assert.match(check, /Unmanaged \(0\):/);
    assert.doesNotMatch(check, /Skipped\/unsafe/);
    assert.doesNotMatch(check, /inspect them manually/);
  });

  test("updates only after a Source refresh and explicit confirmation", async () => {
    await writeFiles(sourceRepo, {
      "skills/alpha/SKILL.md": skillMarkdown("alpha", "Alpha skill v2", "Alpha v2"),
      "skills/alpha/refs/notes.md": "support v2\n",
    });
    git(sourceRepo, "commit", "-qam", "v2");
    assert.match(ok(cli(project, "update", "check", "--scope", "project")), /Updateable \(0\):/);

    ok(cli(project, "source", "refresh", sourceId, "--yes"));
    assert.match(ok(cli(project, "update", "check", "--scope", "project")), /Updateable \(2\):/);

    fails(cli(project, "update", "apply", "--scope", "project", "--all"), /Update not confirmed; rerun with --yes/);
    assert.match(await readFile(path.join(project, ".agents/skills/alpha/SKILL.md"), "utf8"), /Alpha v1/);

    assert.match(ok(cli(project, "update", "apply", "--scope", "project", "--all", "--yes")), /Update summary: 2 updated, 0 failed/);
    assert.match(await readFile(path.join(project, ".agents/skills/alpha/SKILL.md"), "utf8"), /Alpha v2/);
    assert.equal(await readFile(path.join(project, ".agents/skills/alpha/refs/notes.md"), "utf8"), "support v2\n");
    assert.equal(await readlink(path.join(project, ".claude/skills/alpha")), "../../.agents/skills/alpha");
    assert.match(ok(cli(project, "update", "check", "--scope", "project")), /Updateable \(0\):\nCurrent \(2\):/);

    assert.match(ok(cli(project, "update", "apply", "--scope", "user-global", "--skill", "0", "--yes")), /1 updated, 0 failed/);
    assert.match(await readFile(path.join(home, ".agents/skills/alpha/SKILL.md"), "utf8"), /Alpha v2/);
  });

  test("requires --yes and --confirm-path to update a non-canonical adopted project Skill", async () => {
    const adopted = await makeProject("project-adopted");
    await writeFiles(adopted, {
      "vendor/alpha/SKILL.md": skillMarkdown("alpha", "Alpha skill", "Alpha v1"),
      "vendor/alpha/refs/notes.md": "support v1\n",
      "agent-depot.json": JSON.stringify({
        version: 1,
        skills: [{
          source: { kind: "external", url: sourceUrl },
          path: "skills/alpha",
          version: { policy: "latest" },
          hosts: ["pi"],
          installation: {
            path: "vendor/alpha",
            adopted: true,
            resolvedVersion: { kind: "git-commit", commit: firstCommit },
            baseline: { algorithm: "sha256", digest: firstAlphaDigest },
          },
        }],
      }),
    });
    const applyArgs = ["update", "apply", "--scope", "project", "--all"];
    assert.match(ok(cli(adopted, "update", "check", "--scope", "project")), /Updateable \(1\):/);
    const withoutYes = cli(adopted, ...applyArgs);
    fails(withoutYes, /Update not confirmed; rerun with --yes/);
    assert.match(withoutYes.output, /WARNING: non-canonical location/);
    assert.doesNotMatch(await readFile(path.join(adopted, "vendor/alpha/SKILL.md"), "utf8"), /v2/);

    const yesOnly = cli(adopted, ...applyArgs, "--yes");
    fails(yesOnly, /--confirm-path vendor\/alpha/);
    assert.doesNotMatch(await readFile(path.join(adopted, "vendor/alpha/SKILL.md"), "utf8"), /v2/);

    assert.match(ok(cli(adopted, ...applyArgs, "--yes", "--confirm-path", "vendor/alpha")), /1 updated, 0 failed/);
    assert.match(await readFile(path.join(adopted, "vendor/alpha/SKILL.md"), "utf8"), /Alpha v2/);
  });

  test("rejects a hostile manifest path and leaves the targeted directory untouched", async () => {
    const hostile = await makeProject("project-hostile");
    await writeFiles(hostile, {
      "src/demo/SKILL.md": skillMarkdown("demo", "precious", "precious"),
      "src/demo/keep.txt": "do not touch\n",
      "agent-depot.json": JSON.stringify({
        version: 1,
        skills: [{
          source: { kind: "external", url: sourceUrl },
          path: "skills/alpha",
          version: { policy: "latest" },
          hosts: ["pi"],
          installation: {
            path: "src/demo",
            adopted: true,
            resolvedVersion: { kind: "git-commit", commit: firstCommit },
            baseline: { algorithm: "sha256", digest: firstAlphaDigest },
          },
        }],
      }),
    });
    const before = [await readFile(path.join(hostile, "src/demo/SKILL.md"), "utf8"), await readFile(path.join(hostile, "src/demo/keep.txt"), "utf8")];

    const rejected = cli(hostile, "update", "apply", "--scope", "project", "--all", "--yes");
    fails(rejected, /Update summary: 0 updated, 1 failed/);
    assert.match(rejected.output, /outside \.agents\/skills and \.claude\/skills and does not end in the Skill name "alpha"; no path was changed/);

    ok(cli(hostile, "install", "--scope", "project", "--manifest", "--portable-v1", "--yes"));
    assert.deepEqual(
      [await readFile(path.join(hostile, "src/demo/SKILL.md"), "utf8"), await readFile(path.join(hostile, "src/demo/keep.txt"), "utf8")],
      before,
    );
    assert.deepEqual((await readdir(path.join(hostile, "src/demo"))).sort(), ["SKILL.md", "keep.txt"]);
  });

  test("replaces a conflicting Skill only with --overwrite --yes and retains a backup", async () => {
    const conflict = await makeProject("project-conflict");
    await writeFiles(conflict, { ".agents/skills/alpha/SKILL.md": skillMarkdown("alpha", "LOCAL differing", "local") });
    const args = installArgs("project", "alpha", "pi");
    const localSkill = path.join(conflict, ".agents/skills/alpha/SKILL.md");

    fails(cli(conflict, ...args), /Installation not confirmed/);
    const yesOnly = cli(conflict, ...args, "--yes");
    fails(yesOnly, /content-mismatch collision; no path was changed/);
    assert.match(yesOnly.output, /explicit overwrite requires --overwrite --yes/);
    fails(cli(conflict, ...args, "--overwrite"), /Installation not confirmed/);
    assert.match(await readFile(localSkill, "utf8"), /LOCAL differing/);

    assert.match(ok(cli(conflict, ...args, "--overwrite", "--yes")), /Persistent backup retained at/);
    assert.match(await readFile(localSkill, "utf8"), /Alpha v2/);
    const backups = (await readdir(path.join(conflict, ".agents/skills"))).filter((name) => name.startsWith(".agent-depot-backup-"));
    assert.equal(backups.length, 1);
    assert.match(await readFile(path.join(conflict, ".agents/skills", backups[0] ?? "", "SKILL.md"), "utf8"), /LOCAL differing/);
  });

  test("removes an unmanaged global Skill by exact path and refuses managed ones", async () => {
    await writeFiles(home, { ".agents/skills/stray/SKILL.md": skillMarkdown("stray", "unmanaged", "stray") });
    ok(cli(project, ...installArgs("user-global", "gamma", "claude"), "--yes"));

    const check = ok(cli(project, "update", "check", "--scope", "user-global"));
    assert.match(check, /Current \(2\):/);
    assert.match(check, new RegExp(`Unmanaged \\(1\\):\\n  ${path.join(home, ".agents/skills/stray").replaceAll(".", "\\.")}\\n`));
    assert.doesNotMatch(check, /Skipped\/unsafe/);

    const stray = path.join(home, ".agents/skills/stray");
    fails(cli(project, "uninstall", "--unmanaged-skill", stray), /Uninstall not confirmed/);
    assert.equal(await exists(stray), true);
    fails(cli(project, "uninstall", "--unmanaged-skill", path.join(home, ".agents/skills/alpha"), "--yes"), /managed or aliases a managed installation/);
    assert.equal(await exists(path.join(home, ".agents/skills/alpha")), true);
    assert.match(ok(cli(project, "uninstall", "--unmanaged-skill", stray, "--yes")), /Permanently deleted 1 unmanaged user-global Skill/);
    assert.equal(await exists(stray), false);
  });

  test("removes one dependent Skill with its Source, then all Skills, data and the CLI handoff", async () => {
    fails(cli(project, "source", "remove", sourceId), /Removal not confirmed/);
    const removal = ok(cli(project, "source", "remove", sourceId, "--skill", "skills/gamma", "--yes"));
    assert.match(removal, /Removed 1 dependent user-global Skill; other dependent Skills remain tracked/);
    assert.equal(await exists(path.join(home, ".agents/skills/gamma")), false);
    assert.equal(await exists(path.join(home, ".claude/skills/gamma")), false);
    assert.equal(await exists(path.join(home, ".agents/skills/alpha")), true);
    assert.equal(await readlink(path.join(home, ".claude/skills/alpha")), "../../.agents/skills/alpha");

    fails(cli(project, "uninstall", "--skills"), /Uninstall not confirmed/);
    assert.equal(await exists(path.join(home, ".agents/skills/alpha")), true);
    assert.match(ok(cli(project, "uninstall", "--skills", "--yes")), /Removed 1 managed user-global Skill/);
    assert.deepEqual(await readdir(path.join(home, ".agents/skills")), []);
    assert.deepEqual(await readdir(path.join(home, ".claude/skills")), []);
    const state = JSON.parse(await readFile(path.join(sandbox, "state/agent-depot/sources.json"), "utf8"));
    assert.deepEqual(state, { version: 1, gitSources: [], userGlobalInstallations: [] });
    fails(cli(project, "source", "remove", sourceId, "--yes"), /Source is not registered/);

    assert.match(ok(cli(project, "uninstall", "--data", "--yes")), /Removed user-global catalog\/configuration data/);
    assert.equal(await exists(path.join(sandbox, "state/agent-depot/sources.json")), false);
    assert.match(ok(cli(project, "uninstall", "--cli")), /package-manager handoff only/);
  });
});
