import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  GitSourceAccessAdapter,
  GitSourceSnapshotAccess,
  SKILL_TREE_LIMITS,
  sourceIdForUrl,
  type GitSnapshotCommandRunner,
} from "../src/git-source.js";
import { createNodePackageContentAccess, type HostFacingOrigin } from "../src/package-content.js";
import { runProcess } from "../src/process-runner.js";
import type { Source } from "../src/sources.js";

const builtIn: Source = {
  id: "builtin:agent-depot",
  kind: "builtin",
  name: "Agent Depot",
  packageOwned: true,
};

async function git(args: readonly string[]): Promise<void> {
  const result = await runProcess("git", args);
  assert.equal(result.code, 0, result.stderr);
}

/**
 * Creates a real Git repository, commits the given files, and mirrors it through
 * the real bare-mirror adapter, mapping only the transport URL to the local path.
 */
async function withFixture<T>(
  files: ReadonlyMap<string, string>,
  url: string,
  transportUrl: string,
  run: (fixture: { cachePath: string; source: Source; root: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-package-content-"));
  try {
    const repository = path.join(root, "repository");
    const cachePath = path.join(root, "cache");
    await mkdir(repository);
    await git(["init", "--initial-branch=main", repository]);
    for (const [relativePath, content] of files) {
      const target = path.join(repository, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await git(["-C", repository, "add", "."]);
    await git(["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);

    const source: Source = { id: sourceIdForUrl(url), kind: "git", url };
    const adapter = new GitSourceAccessAdapter({
      cachePath,
      runner: {
        async run(command, args) {
          assert.equal(command, "git");
          await git(args.map((argument) => argument === transportUrl ? repository : argument));
        },
      },
    });
    await adapter.refresh(source);
    return await run({ cachePath, source, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class FakeSnapshotRunner implements GitSnapshotCommandRunner {
  constructor(
    private readonly tree: string,
    private readonly blobs: ReadonlyMap<string, string> = new Map(),
    private readonly commit = "a".repeat(40),
  ) {}

  async run(command: string, args: readonly string[]): Promise<string> {
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
      return content;
    }
    throw new Error(`unexpected git snapshot command: ${args.join(" ")}`);
  }

  async runBinary(): Promise<Uint8Array> {
    throw new Error("runBinary not expected");
  }
}

test("readView reads fixture files at a resolved commit and reports the scheme-stripped repository origin", async () => {
  await withFixture(
    new Map([
      ["package.json", `{"name":"p","version":"1.0.0"}`],
      ["src/index.ts", "export {};\n"],
      ["nested/deep/file.md", "deep"],
    ]),
    "https://github.com/example/skills.git",
    "https://github.com/example/skills.git",
    async ({ cachePath, source }) => {
      const view = await createNodePackageContentAccess({ gitCachePath: cachePath }).readView(source);

      assert.deepEqual(view.origin, { kind: "git", repositoryUrl: "github.com/example/skills.git" });
      assert.match(view.resolvedCommit ?? "", /^[0-9a-f]{40,64}$/u);
      assert.deepEqual(await view.list(""), ["nested/deep/file.md", "package.json", "src/index.ts"]);
      assert.deepEqual(await view.find("", ["package.json"]), ["package.json"]);
      assert.deepEqual(await view.find("src", ["index.ts"]), ["src/index.ts"]);
      assert.deepEqual(await view.find("", ["missing.txt"]), []);
      assert.equal(await view.read("package.json"), `{"name":"p","version":"1.0.0"}`);
      assert.equal(await view.read("nested/deep/file.md"), "deep");
      assert.equal(await view.read("missing.txt"), undefined);
    },
  );
});

test("readView strips the ssh scheme while preserving the git username", async () => {
  await withFixture(
    new Map([["package.json", `{"name":"p"}`]]),
    "ssh://git@github.com/example/skills.git",
    "ssh://git@github.com/example/skills.git",
    async ({ cachePath, source }) => {
      const view = await createNodePackageContentAccess({ gitCachePath: cachePath }).readView(source);
      assert.deepEqual(view.origin, { kind: "git", repositoryUrl: "git@github.com/example/skills.git" });
    },
  );
});

test("a scoped GitHub tree Source carries its directory and ref, reads scope-relative paths, and leaks no local path", async () => {
  await withFixture(
    new Map([
      ["pstack/package.json", `{"name":"pstack","pi":{"skills":["./skills"]}}`],
      ["pstack/skills/a/SKILL.md", "---\nname: A\ndescription: A skill\n---\n"],
      ["other/package.json", `{"name":"sibling"}`],
    ]),
    "https://github.com/owner/repo/tree/main/pstack",
    "https://github.com/owner/repo",
    async ({ cachePath, source, root }) => {
      const view = await createNodePackageContentAccess({ gitCachePath: cachePath }).readView(source);

      assert.deepEqual(view.origin, {
        kind: "git",
        repositoryUrl: "github.com/owner/repo",
        ref: "main",
        directory: "pstack",
      });
      assertOriginCarriesNoLocalPath(view.origin, [cachePath, root]);
      assert.deepEqual(await view.list(""), ["package.json", "skills/a/SKILL.md"]);
      assert.deepEqual(await view.find("", ["package.json"]), ["package.json"]);
      assert.equal(await view.read("package.json"), `{"name":"pstack","pi":{"skills":["./skills"]}}`);
      assert.equal(await view.read("skills/a/SKILL.md"), "---\nname: A\ndescription: A skill\n---\n");
      assert.equal(await view.read("other/package.json"), undefined);
    },
  );
});

test("the builtin Source yields a builtin origin and reads the builtin root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-package-builtin-"));
  try {
    const builtInRoot = path.join(root, "skills");
    await mkdir(path.join(builtInRoot, "nested"), { recursive: true });
    await writeFile(path.join(builtInRoot, "package.json"), `{"name":"builtin"}`);
    await writeFile(path.join(builtInRoot, "nested", "file.md"), "nested");

    const view = await createNodePackageContentAccess({ builtInRoot }).readView(builtIn);

    assert.deepEqual(view.origin, { kind: "builtin" });
    assert.equal(view.resolvedCommit, undefined);
    assert.deepEqual(await view.list(""), ["nested/file.md", "package.json"]);
    assert.deepEqual(await view.find("", ["package.json"]), ["package.json"]);
    assert.equal(await view.read("package.json"), `{"name":"builtin"}`);
    assert.equal(await view.read("missing.txt"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listFiles and readFile reject a missing mirror through the shared bare-mirror guard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-package-nomirror-"));
  try {
    const cachePath = path.join(root, "cache");
    const url = "https://github.com/example/skills.git";
    const source: Source = { id: sourceIdForUrl(url), kind: "git", url };
    const access = new GitSourceSnapshotAccess({ cachePath });

    await assert.rejects(access.listFiles(source, ""), /mirror is not available/u);
    await assert.rejects(access.readFile(source, "package.json"), /mirror is not available/u);
    await assert.rejects(createNodePackageContentAccess({ gitCachePath: cachePath }).readView(source), /mirror is not available/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listFiles and readFile reject a symlinked mirror path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-package-symlink-"));
  try {
    const cachePath = path.join(root, "cache");
    const url = "https://github.com/example/skills.git";
    const source: Source = { id: sourceIdForUrl(url), kind: "git", url };
    const destination = path.join(cachePath, source.id.slice("git:".length));
    await mkdir(cachePath, { recursive: true });
    await mkdir(path.join(root, "real"), { recursive: true });
    try {
      await symlink(path.join(root, "real"), destination, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        return;
      }
      throw error;
    }

    const access = new GitSourceSnapshotAccess({ cachePath });
    await assert.rejects(access.listFiles(source, ""), /mirror is not available/u);
    await assert.rejects(access.readFile(source, "package.json"), /mirror is not available/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listFiles stays under the requested root and skips symlink and non-blob entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-package-listing-"));
  try {
    const cachePath = path.join(root, "cache");
    const url = "https://github.com/example/skills.git";
    const source: Source = { id: sourceIdForUrl(url), kind: "git", url };
    await mkdir(path.join(cachePath, source.id.slice("git:".length)), { recursive: true });
    const runner = new FakeSnapshotRunner([
      "100644 blob one\troot/package.json\0",
      "100644 blob two\troot/sub/file.md\0",
      "120000 blob three\troot/link.md\0",
      "160000 commit four\troot/vendor\0",
      "100644 blob five\tother/file.md\0",
    ].join(""));

    const access = new GitSourceSnapshotAccess({ cachePath, runner });
    assert.deepEqual(await access.listFiles(source, "root"), ["root/package.json", "root/sub/file.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readFile returns undefined for an absent or symlinked path and rejects an oversized blob", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-package-readfile-"));
  try {
    const cachePath = path.join(root, "cache");
    const url = "https://github.com/example/skills.git";
    const source: Source = { id: sourceIdForUrl(url), kind: "git", url };
    await mkdir(path.join(cachePath, source.id.slice("git:".length)), { recursive: true });

    const absent = new GitSourceSnapshotAccess({ cachePath, runner: new FakeSnapshotRunner("") });
    assert.equal(await absent.readFile(source, "nope.txt"), undefined);

    const symlinked = new GitSourceSnapshotAccess({
      cachePath,
      runner: new FakeSnapshotRunner("120000 blob three\tlink.md\0"),
    });
    assert.equal(await symlinked.readFile(source, "link.md"), undefined);

    const objectId = "b".repeat(40);
    const oversized = new GitSourceSnapshotAccess({
      cachePath,
      runner: new FakeSnapshotRunner(
        `100644 blob ${objectId}\tbig.md\0`,
        new Map([[objectId, "x".repeat(SKILL_TREE_LIMITS.maxFileBytes + 1)]]),
      ),
    });
    await assert.rejects(oversized.readFile(source, "big.md"), /size limit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function assertOriginCarriesNoLocalPath(origin: HostFacingOrigin, localPaths: readonly string[]): void {
  const serialized = JSON.stringify(origin);
  for (const localPath of localPaths) {
    assert.equal(serialized.includes(localPath), false, `origin leaks a local path: ${serialized}`);
  }
}
