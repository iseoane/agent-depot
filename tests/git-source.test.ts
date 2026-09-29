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
  GitSourceSnapshotAccess,
  SKILL_TREE_LIMITS,
  sourceIdForUrl,
  type GitCommandRunner,
  type GitSnapshotCommandRunner,
} from "../src/git-source.js";

class FakeSnapshotRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];

  async run(command: string, args: readonly string[]): Promise<string> {
    this.calls.push({ command, args: [...args] });
    if (args[args.length - 1] === "HEAD^{commit}") {
      return `${"a".repeat(40)}\n`;
    }
    if (args.includes("ls-tree")) {
      return [
        "100644 blob one\tgood/SKILL.md\0",
        "100644 blob four\tgood/notes.txt\0",
        "100644 blob five\tREADME.md\0",
        "120000 blob two\tlinked/SKILL.md\0",
        "100644 blob six\tdeprecated/hidden/SKILL.md\0",
        "100644 blob three\tdeprecated/SKILL.md\0",
      ].join("");
    }
    if (args[args.length - 1] === `${"a".repeat(40)}:good/SKILL.md`) {
      return "---\nname: Good\ndescription: Good skill\n---\n";
    }
    if (args[args.length - 1] === `${"a".repeat(40)}:deprecated/SKILL.md`) {
      return "---\nname: Deprecated\ndescription: Deprecated skill\n---\n";
    }
    throw new Error(`unexpected git snapshot command: ${args.join(" ")}`);
  }

  async runBinary(command: string, args: readonly string[]): Promise<Uint8Array> {
    return Buffer.from(await this.run(command, args), "utf8");
  }
}

class FakeSelectedSnapshotRunner implements GitSnapshotCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  constructor(
    private readonly tree: string,
    private readonly blobs: ReadonlyMap<string, string | Uint8Array>,
    private readonly commit = "e".repeat(40),
  ) {}

  async run(command: string, args: readonly string[]): Promise<string> {
    this.calls.push({ command, args: [...args] });
    if (args[args.length - 1]?.endsWith("^{commit}")) {
      return `${this.commit}\n`;
    }
    if (args.includes("ls-tree")) {
      return this.tree;
    }
    if (args.includes("cat-file")) {
      const content = this.blobs.get(args[args.length - 1]);
      if (content === undefined) {
        throw new Error(`unexpected blob ${args[args.length - 1]}`);
      }
      return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
    }
    throw new Error(`unexpected git snapshot command: ${args.join(" ")}`);
  }

  async runBinary(command: string, args: readonly string[]): Promise<Uint8Array> {
    this.calls.push({ command, args: [...args] });
    const content = this.blobs.get(args[args.length - 1]);
    if (content === undefined) {
      throw new Error(`unexpected blob ${args[args.length - 1]}`);
    }
    return typeof content === "string" ? Buffer.from(content, "utf8") : content;
  }
}

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

test("resolves trustworthy Git commit evidence from the selected ref without refreshing", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
      ref: "refs/tags/v1.2.3",
    };
    await mkdir(path.join(cachePath, source.id.slice(4)), { recursive: true });
    const runner = new FakeSelectedSnapshotRunner("", new Map(), "f".repeat(40));

    assert.equal(await new GitSourceSnapshotAccess({ cachePath, runner }).readResolvedCommit(source), "f".repeat(40));
    assert.equal(runner.calls[0]?.args.at(-1), "refs/tags/v1.2.3^{commit}");
  });
});

test("reads the cached bare mirror HEAD without refreshing and ignores Git symlink entries", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    await mkdir(path.join(cachePath, source.id.slice(4)), { recursive: true });
    const runner = new FakeSnapshotRunner();
    const access = new GitSourceSnapshotAccess({ cachePath, runner });

    assert.deepEqual(await access.readSnapshot(source), [{
      path: "good/SKILL.md",
      content: "---\nname: Good\ndescription: Good skill\n---\n",
    }]);
    assert.deepEqual(runner.calls.map((call) => call.args[call.args.length - 1]), [
      "HEAD^{commit}",
      "a".repeat(40),
      `${"a".repeat(40)}:good/SKILL.md`,
    ]);
  });
});

test("ties selected Git Skill bytes and revision to one snapshot", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    await mkdir(path.join(cachePath, source.id.slice(4)), { recursive: true });
    const objectId = "a".repeat(40);
    const runner = new FakeSelectedSnapshotRunner(
      `100644 blob ${objectId}\tselected/SKILL.md\0`,
      new Map([[objectId, "skill"]]),
      "e".repeat(40),
    );

    const snapshot = await new GitSourceSnapshotAccess({ cachePath, runner }).readSkillTreeSnapshot(source, "selected");

    assert.equal(snapshot.resolvedVersion, "e".repeat(40));
    assert.deepEqual(snapshot.files.map((file) => file.path), ["selected/SKILL.md"]);
    assert.equal(runner.calls.filter((call) => call.args.includes("rev-parse")).length, 1);
    const treeCall = runner.calls.find((call) => call.args.includes("ls-tree"));
    assert.ok(treeCall);
    assert.equal(treeCall.args.includes("e".repeat(40)), true);
  });
});

test("reads a selected Git Skill tree with supporting files using blob object IDs", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    await mkdir(path.join(cachePath, source.id.slice(4)), { recursive: true });
    const skillManifestObject = "a".repeat(40);
    const referenceObject = "b".repeat(40);
    const scriptObject = "c".repeat(40);
    const assetObject = "d".repeat(40);
    const scriptBytes = Uint8Array.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0x00, 0xff]);
    const assetBytes = Uint8Array.from([0x00, 0xff, 0x01, 0x80]);
    const runner = new FakeSelectedSnapshotRunner(
      [
        `100644 blob ${skillManifestObject}\tselected/SKILL.md\0`,
        `100644 blob ${referenceObject}\tselected/references/guide.md\0`,
        `100755 blob ${scriptObject}\tselected/scripts/check.sh\0`,
        `100644 blob ${assetObject}\tselected/assets/image.bin\0`,
      ].join(""),
      new Map<string, string | Uint8Array>([
        [skillManifestObject, "---\nname: Selected\ndescription: Selected skill\n---\n"],
        [referenceObject, "reference"],
        [scriptObject, scriptBytes],
        [assetObject, assetBytes],
      ]),
    );

    const access = new GitSourceSnapshotAccess({ cachePath, runner });
    const files = await access.readSkillTree(source, "selected");
    assert.deepEqual(files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content),
      executable: file.executable,
    })), [
      { path: "selected/SKILL.md", content: Buffer.from("---\nname: Selected\ndescription: Selected skill\n---\n"), executable: false },
      { path: "selected/references/guide.md", content: Buffer.from("reference"), executable: false },
      { path: "selected/scripts/check.sh", content: Buffer.from(scriptBytes), executable: true },
      { path: "selected/assets/image.bin", content: Buffer.from(assetBytes), executable: false },
    ]);
    const catFileCalls = runner.calls.filter((call) => call.args.includes("cat-file"));
    assert.deepEqual(catFileCalls.map((call) => call.args[call.args.length - 1]), [
      skillManifestObject,
      referenceObject,
      scriptObject,
      assetObject,
    ]);
    assert.equal(catFileCalls.some((call) => call.args.some((argument) => argument.includes("selected/"))), false);
  });
});

test("reads the manifest-selected Git ref instead of silently falling back to HEAD", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
      ref: "refs/tags/v1.2.3",
    };
    await mkdir(path.join(cachePath, source.id.slice(4)), { recursive: true });
    const objectId = "a".repeat(40);
    const runner = new FakeSelectedSnapshotRunner(
      `100644 blob ${objectId}\tselected/SKILL.md\0`,
      new Map([[objectId, "skill"]]),
    );
    await new GitSourceSnapshotAccess({ cachePath, runner }).readSkillTree(source, "selected");
    assert.equal(runner.calls[0]?.args.at(-1), "refs/tags/v1.2.3^{commit}");
  });
});

test("rejects Git symlink entries, traversal paths, unsafe refs, and oversized blobs", async () => {
  await withCache(async (cachePath) => {
    const source = {
      id: sourceIdForUrl("https://github.com/example/skills.git"),
      kind: "git" as const,
      url: "https://github.com/example/skills.git",
    };
    await mkdir(path.join(cachePath, source.id.slice(4)), { recursive: true });
    const objectId = "d".repeat(40);

    const symlinkRunner = new FakeSelectedSnapshotRunner(
      `120000 blob ${objectId}\tselected/SKILL.md\0`,
      new Map([[objectId, "target"]]),
    );
    await assert.rejects(
      new GitSourceSnapshotAccess({ cachePath, runner: symlinkRunner }).readSkillTree(source, "selected"),
      /unsupported Git entry/i,
    );
    assert.equal(symlinkRunner.calls.some((call) => call.args.includes("cat-file")), false);

    const traversalRunner = new FakeSelectedSnapshotRunner(
      `100644 blob ${objectId}\tselected/../escape/SKILL.md\0`,
      new Map([[objectId, "unsafe"]]),
    );
    await assert.rejects(
      new GitSourceSnapshotAccess({ cachePath, runner: traversalRunner }).readSkillTree(source, "selected"),
      /outside the selected directory/i,
    );

    const unsafeRefRunner = new FakeSelectedSnapshotRunner(
      "",
      new Map(),
      "abc123;--delete",
    );
    await assert.rejects(
      new GitSourceSnapshotAccess({ cachePath, runner: unsafeRefRunner }).readSkillTree(source, "selected"),
      /safe HEAD snapshot/i,
    );

    const largeRunner = new FakeSelectedSnapshotRunner(
      `100644 blob ${objectId}\tselected/SKILL.md\0`,
      new Map([[objectId, "x".repeat(SKILL_TREE_LIMITS.maxFileBytes + 1)]]),
    );
    await assert.rejects(
      new GitSourceSnapshotAccess({ cachePath, runner: largeRunner }).readSkillTree(source, "selected"),
      /size limit/i,
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
