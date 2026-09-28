import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { test } from "node:test";

import {
  defaultGitSourceCachePath,
  GitSourceAccessAdapter,
  GitSourceAccessError,
  sourceIdForUrl,
  type GitCommandRunner,
} from "../src/git-source.js";

class FakeGitRunner implements GitCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];

  constructor(private readonly cloneDelayMs = 0) {}

  async run(command: string, args: readonly string[], options: { cwd?: string } = {}): Promise<void> {
    this.calls.push({ command, args: [...args], cwd: options.cwd });
    if (command === "git" && args[0] === "clone") {
      await delay(this.cloneDelayMs);
      await mkdir(args[args.length - 1], { recursive: true });
    }
  }
}

async function withCache<T>(run: (cachePath: string, runner: FakeGitRunner) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-git-"));
  try {
    const runner = new FakeGitRunner();
    return await run(path.join(directory, "cache"), runner);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("clones a new Source into an external bare mirror cache using the registered URL", async () => {
  await withCache(async (cachePath, runner) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    const access = new GitSourceAccessAdapter({ cachePath, runner });

    await access.refresh(source);

    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].command, "git");
    const cloneArguments = runner.calls[0].args;
    assert.deepEqual(cloneArguments.slice(0, 3), ["clone", "--mirror", source.url]);
    const expectedTemporaryPrefix = `${path.join(cachePath, source.id.slice(4))}.`;
    assert.equal(cloneArguments[3].startsWith(expectedTemporaryPrefix), true);
    assert.equal(cloneArguments[3].endsWith(".tmp"), true);
    assert.equal(runner.calls[0].cwd, undefined);
    assert.equal(runner.calls[0].args.includes("checkout"), false);
  });
});

test("fetches every ref from the registered URL and prunes deleted refs", async () => {
  await withCache(async (cachePath, runner) => {
    const source = {
      id: sourceIdForUrl("ssh://git@github.com/example/skills.git"),
      kind: "git" as const,
      url: "ssh://git@github.com/example/skills.git",
    };
    const destination = path.join(cachePath, source.id.slice(4));
    await mkdir(destination, { recursive: true });
    const access = new GitSourceAccessAdapter({ cachePath, runner });

    await access.refresh(source);

    assert.deepEqual(runner.calls, [{
      command: "git",
      args: ["-C", destination, "fetch", "--prune", "--force", source.url, "+refs/*:refs/*"],
      cwd: undefined,
    }]);
  });
});

test("rejects cache symlinks instead of following them", async () => {
  await withCache(async (cachePath, runner) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    await mkdir(cachePath, { recursive: true });
    const destination = path.join(cachePath, source.id.slice(4));
    try {
      await symlink("/tmp", destination, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        return;
      }
      throw error;
    }

    await assert.rejects(
      new GitSourceAccessAdapter({ cachePath, runner }).refresh(source),
      (error: unknown) => error instanceof GitSourceAccessError && error.message.includes("symbolic link"),
    );
    assert.equal(runner.calls.length, 0);
  });
});

test("serializes concurrent first clones for the same Source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-git-race-"));
  try {
    const cachePath = path.join(directory, "cache");
    const runner = new FakeGitRunner(25);
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };

    await Promise.all([
      new GitSourceAccessAdapter({ cachePath, runner }).refresh(source),
      new GitSourceAccessAdapter({ cachePath, runner }).refresh(source),
    ]);

    assert.equal(runner.calls.filter((call) => call.args[0] === "clone").length, 1);
    assert.equal(runner.calls.filter((call) => call.args[0] === "-C").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports Git failures through a clean Source access error", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    const runner: GitCommandRunner = {
      async run(): Promise<void> {
        throw new Error("network unavailable");
      },
    };

    await assert.rejects(
      new GitSourceAccessAdapter({ cachePath, runner }).refresh(source),
      (error: unknown) => error instanceof GitSourceAccessError
        && error.message.includes("network unavailable")
        && error.message.includes(source.url),
    );
  });
});

test("uses portable cache locations separate from the Source state location", () => {
  assert.equal(
    defaultGitSourceCachePath({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/alice"),
    "/cache/agent-depot/git-sources",
  );
  assert.equal(
    defaultGitSourceCachePath({ LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, "win32", "C:\\Users\\alice"),
    "C:\\Users\\alice\\AppData\\Local\\Agent Depot\\git-sources",
  );
});
