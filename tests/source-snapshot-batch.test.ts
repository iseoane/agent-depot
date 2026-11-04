import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GitSourceSnapshotAccess, sourceIdForUrl, type GitSnapshotCommandRunner } from "../src/git-source.js";
import { runProcess } from "../src/process-runner.js";

type Input = { readonly maxOutputBytes?: number; readonly stdin?: Uint8Array };
class CountingRunner implements GitSnapshotCommandRunner {
  readonly calls: string[][] = [];
  async run(command: string, args: readonly string[], options?: Input): Promise<string> {
    return Buffer.from(await this.runBinary(command, args, options)).toString("utf8");
  }
  async runBinary(command: string, args: readonly string[], options?: Input): Promise<Uint8Array> {
    this.calls.push([...args]);
    const result = await runProcess(command, args, { ...options, captureStdout: true });
    assert.equal(result.outputTooLarge, false);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  }
}
async function fixture(run: (root: string, mirror: string, source: { id: string; kind: "git"; url: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "depot-batch-"));
  const url = "https://github.com/example/batch";
  const source = { id: sourceIdForUrl(url), kind: "git" as const, url };
  const mirror = path.join(root, "cache", source.id.slice(4));
  const git = async (...args: string[]) => {
    const result = await runProcess("git", args, { cwd: root });
    assert.equal(result.code, 0, result.stderr);
  };
  try {
    await git("init", "-q", "-b", "main");
    for (const name of ["alpha", "omega", "deprecated/hidden"]) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\n---\ná\u0000tail\n`);
    }
    await writeFile(path.join(root, "README.md"), "not part of the snapshot");
    await git("add", ".");
    await git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture");
    await git("clone", "--quiet", "--mirror", root, mirror);
    await run(root, mirror, source);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Source snapshot preserves bytes and exclusions with one batch, not per-file processes", async () => {
  await fixture(async (root, mirror, source) => {
    const runner = new CountingRunner();
    const access = new GitSourceSnapshotAccess({ cachePath: path.join(root, "cache"), runner });
    assert.deepEqual(await access.readSnapshot(source), ["alpha", "omega"].map(name => ({
      path: `${name}/SKILL.md`, content: `---\nname: ${name}\n---\ná\u0000tail\n`,
    })));
    assert.equal(runner.calls.filter(args => args.includes("show")).length, 0, "no child per file");
    assert.equal(runner.calls.filter(args => args.includes("--batch")).length, 1);
    assert.ok(mirror.endsWith(source.id.slice(4)));
  });
});

test("Source snapshots coalesce across readers but re-resolve changed commits", async () => {
  await fixture(async (root, mirror, source) => {
    const runner = new CountingRunner();
    const options = { cachePath: path.join(root, "cache"), runner };
    const first = new GitSourceSnapshotAccess(options);
    const second = new GitSourceSnapshotAccess(options);
    const values = await Promise.all([first.readSnapshot(source), second.readSnapshot(source)]);
    assert.deepEqual(values[0], values[1]);
    assert.deepEqual(await second.readSnapshot(source), values[0]);
    assert.equal(runner.calls.filter(args => args.includes("ls-tree")).length, 1, "same immutable snapshot read once");
    await writeFile(path.join(root, "alpha", "SKILL.md"), "changed manifest");
    for (const args of [["add", "alpha/SKILL.md"], ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "changed"]]) {
      assert.equal((await runProcess("git", args, { cwd: root })).code, 0);
    }
    assert.equal((await runProcess("git", ["--git-dir", mirror, "fetch", "--quiet", root, "main:refs/heads/main"])).code, 0);
    assert.equal((await first.readSnapshot(source))[0].content, "changed manifest");
    assert.equal(runner.calls.filter(args => args.includes("ls-tree")).length, 2);
  });
});
