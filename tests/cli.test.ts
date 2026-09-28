import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUILT_IN_SOURCE, SourceNotFoundError, type SourceOperations } from "../src/sources.js";
import { runCli } from "../src/cli.js";

const external = {
  id: "git:1234567890abcdef12345678",
  kind: "git" as const,
  url: "https://github.com/example/skills.git",
};

function fakeOperations(overrides: Partial<SourceOperations> = {}): SourceOperations {
  return {
    async addGitSource() {
      return external;
    },
    async listSources() {
      return [BUILT_IN_SOURCE, external];
    },
    async refreshSource() {
      return external;
    },
    async selectSources() {
      return [external];
    },
    ...overrides,
  };
}

test("runs through direct and symlinked package entrypoints", async (t) => {
  const cliPath = path.resolve("dist/src/cli.js");
  const direct = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /Usage:/);

  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-"));
  try {
    const linkedPath = path.join(directory, "agent-depot");
    try {
      await symlink(cliPath, linkedPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const linked = spawnSync(process.execPath, [linkedPath], { encoding: "utf8" });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists Sources and marks the built-in Source read-only", async () => {
  const output: string[] = [];

  const exitCode = await runCli(["source", "list"], {
    operations: fakeOperations(),
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(`stderr: ${line}`),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(output, [
    "builtin:agent-depot\tbuiltin\tAgent Depot\tread-only",
    `${external.id}\tgit\t${external.url}`,
  ]);
});

test("adds a Source and requires explicit refresh confirmation before network access", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const calls: string[] = [];
  const operations = fakeOperations({
    async addGitSource(url) {
      calls.push(`add:${url}`);
      return external;
    },
    async refreshSource(id) {
      calls.push(`refresh:${id}`);
      return external;
    },
  });

  assert.equal(await runCli(["source", "add", external.url], { operations, stdout: (line) => output.push(line) }), 0);
  assert.equal(await runCli(["source", "refresh", external.id], {
    operations,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  }), 1);
  assert.equal(await runCli(["source", "refresh", external.id, "--yes"], {
    operations,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  }), 0);

  assert.deepEqual(calls, [`add:${external.url}`, `refresh:${external.id}`]);
  assert.deepEqual(output, [
    `Added Git Source: ${external.id}\t${external.url}`,
    `Preview: refresh Git Source ${external.id} from ${external.url}`,
    `Preview: refresh Git Source ${external.id} from ${external.url}`,
    `Refreshed Git Source: ${external.id}\t${external.url}`,
  ]);
  assert.deepEqual(errors, ["Error: Refresh not confirmed; rerun with --yes to continue"]);
});

test("does not expose discovery selection or refresh the built-in Source", async () => {
  const errors: string[] = [];
  const operations = fakeOperations({
    async refreshSource() {
      throw new Error("refresh should not be called");
    },
  });

  assert.equal(await runCli(["source", "select", external.id], {
    operations,
    stderr: (line) => errors.push(line),
  }), 1);
  assert.equal(await runCli(["source", "refresh", BUILT_IN_SOURCE.id, "--yes"], {
    operations,
    stderr: (line) => errors.push(line),
  }), 1);
  assert.deepEqual(errors, [
    "Error: Usage:\n  agent-depot source list\n  agent-depot source add <url>\n  agent-depot source refresh <id> [--yes]\n  agent-depot discover <source-id> [source-id...]",
    "Error: The package-owned built-in Source cannot be refreshed or changed",
  ]);
});

test("discovers candidates from the explicitly supplied Source IDs", async () => {
  const output: string[] = [];
  const calls: string[][] = [];
  const operations = fakeOperations({
    async listSources() {
      throw new Error("discover must not select Sources through the CLI");
    },
    async discoverSkills(sourceIds) {
      calls.push([...sourceIds]);
      return [{
        sourceId: external.id,
        path: "chosen",
        name: "Chosen",
        description: "Chosen skill",
      }];
    },
  });

  const exitCode = await runCli(["discover", BUILT_IN_SOURCE.id, external.id], {
    operations,
    stdout: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [[BUILT_IN_SOURCE.id, external.id]]);
  assert.deepEqual(output, [
    `Candidate: ${external.id}\tchosen\tChosen\tChosen skill`,
  ]);
});

test("requires at least one explicit Source ID for discovery", async () => {
  const errors: string[] = [];
  let called = false;
  const operations = fakeOperations({
    async discoverSkills() {
      called = true;
      return [];
    },
  });

  const exitCode = await runCli(["discover"], {
    operations,
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.deepEqual(errors, [
    "Error: Usage: agent-depot discover <source-id> [source-id...]\nSelect at least one Source ID explicitly; run `agent-depot source list` to see registered Sources",
  ]);
});

test("reports how to recover when a selected Source is not registered", async () => {
  const errors: string[] = [];
  const operations = fakeOperations({
    async discoverSkills() {
      throw new SourceNotFoundError("git:missing");
    },
  });

  const exitCode = await runCli(["discover", "git:missing"], {
    operations,
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(errors, [
    "Error: Source is not registered: git:missing. Run `agent-depot source list` and pass a registered Source ID",
  ]);
});
