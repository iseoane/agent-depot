import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, readlink, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fakeAppFixture } from "./fake-app-fixture.js";

export const profileSourceUrl = "https://example.test/profile/source.git";

/** Git's URL rewrite keeps a portable HTTPS identity while all transport stays offline. */
export async function profileSandbox(root: string, sourceRepo: string) {
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const gitConfig = path.join(root, "gitconfig");
  await writeFile(gitConfig, `[url "file://${sourceRepo}"]\n\tinsteadOf = ${profileSourceUrl}\n[protocol "file"]\n\tallow = always\n`);
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.test",
    GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.test",
  };
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), ...args], { cwd: root, env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
  };
  const ok = (...args: string[]) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.output);
    return result.output;
  };
  return { root, home, env, cli, ok };
}

export async function seedProfileSandbox(side: Awaited<ReturnType<typeof profileSandbox>>, sourceRepo: string) {
  await mkdir(path.join(sourceRepo, "skills/alpha"), { recursive: true });
  await writeFile(path.join(sourceRepo, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: Offline profile fixture\n---\n# Alpha\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: sourceRepo, env: side.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const sourceId = /git:[0-9a-f]+/.exec(side.ok("source", "add", profileSourceUrl))?.[0];
  assert.ok(sourceId);
  for (const [source, skill] of [[sourceId, "skills/alpha"], ["builtin:agent-depot", "agent-depot-apprecipe"]]) {
    side.ok("install", "--source", source!, "--skill", skill!, "--version", "latest", "--portable-v1", "--scope", "user-global", "--host", "claude", "--host", "pi", "--yes");
  }
  const fixture = await fakeAppFixture(side.root);
  side.env.PATH = `${fixture.bin}${path.delimiter}${process.env.PATH}`;
  await writeFile(fixture.file, JSON.stringify({ ...fixture.recipe, platform: "linux" }));
  await writeFile(path.join(fixture.stateDirectory, "apps/windows.json"), JSON.stringify({ ...fixture.recipe, platform: "windows" }));
  side.ok("app", "approve", "fixture-app", "--yes");
  return fixture;
}

/** Capture contents and mtimes, including symlinks, to detect even identical rewrites. */
export async function profileFiles(root: string): Promise<Record<string, { content: string; mtime: number }>> {
  const files: Record<string, { content: string; mtime: number }> = {};
  async function walk(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await walk(file);
      else files[path.relative(root, file)] = { content: stat.isSymbolicLink() ? await readlink(file) : (await readFile(file)).toString("base64"), mtime: stat.mtimeMs };
    }
  }
  await walk(root);
  return files;
}
