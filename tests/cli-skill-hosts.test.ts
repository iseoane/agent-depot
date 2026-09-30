import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import type { ProjectHost } from "../src/project-manifest.js";
import { BUILT_IN_SOURCE, createSourceOperations, type SourceOperations } from "../src/sources.js";

interface Context {
  readonly home: string;
  readonly operations: SourceOperations;
  readonly lines: string[];
  readonly errors: string[];
  readonly cli: (argv: string[]) => Promise<number>;
}

const canonical = (home: string) => path.join(home, ".agents", "skills", "one");
const claude = (home: string) => path.join(home, ".claude", "skills", "one");
const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

async function withSkill(hosts: readonly ProjectHost[], run: (context: Context) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-hosts-home-"));
  const state = await mkdtemp(path.join(tmpdir(), "agent-depot-cli-hosts-state-"));
  try {
    const operations = createSourceOperations({ statePath: path.join(state, "sources.json") });
    await mkdir(canonical(home), { recursive: true });
    await writeFile(path.join(canonical(home), "SKILL.md"), "one", "utf8");
    if (hosts.includes("claude")) {
      await mkdir(path.dirname(claude(home)), { recursive: true });
      await symlink(path.join("..", "..", ".agents", "skills", "one"), claude(home), "dir");
    }
    await operations.addUserGlobalInstallation!({
      source: { kind: "builtin", id: BUILT_IN_SOURCE.id },
      path: "portable/one",
      version: { policy: "latest" },
      hosts,
      installation: { path: ".agents/skills/one", adopted: false },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const cli = (argv: string[]) => runCli(argv, { operations, homeDirectory: home, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) });
    await run({ home, operations, lines, errors, cli });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
}

const hostsOf = async (operations: SourceOperations) => (await operations.listUserGlobalInstallations!())[0]?.hosts;

test("skill host add previews new locations and changes nothing without --yes", async () => {
  await withSkill(["pi"], async ({ home, operations, lines, errors, cli }) => {
    assert.equal(await cli(["skill", "host", "add", "portable/one", "--host", "claude"]), 1);
    assert.match(lines.join("\n"), /add hosts claude to "portable\/one"/u);
    assert.match(lines.join("\n"), /\.claude\/skills\/one/u);
    assert.match(errors.join("\n"), /not confirmed; rerun with --yes/u);
    assert.equal(await exists(claude(home)), false);
    assert.deepEqual(await hostsOf(operations), ["pi"]);
  });
});

test("skill host add needs --confirm-additional-host even with --yes", async () => {
  await withSkill(["pi"], async ({ home, operations, errors, cli }) => {
    assert.equal(await cli(["skill", "host", "add", "one", "--host", "claude", "--yes"]), 1);
    assert.match(errors.join("\n"), /--confirm-additional-host/u);
    assert.equal(await exists(claude(home)), false);
    assert.deepEqual(await hostsOf(operations), ["pi"]);
  });
});

test("skill host add exposes the installed Skill and records the host", async () => {
  await withSkill(["pi"], async ({ home, operations, lines, cli }) => {
    assert.equal(await cli(["skill", "host", "add", "one", "--host", "claude", "--yes", "--confirm-additional-host"]), 0);
    assert.equal(await readlink(claude(home)), path.join("..", "..", ".agents", "skills", "one"));
    assert.deepEqual(await hostsOf(operations), ["pi", "claude"]);
    assert.match(lines.join("\n"), /Added hosts claude to "portable\/one"/u);
  });
});

test("skill host add validates its arguments", async () => {
  await withSkill(["pi"], async ({ errors, cli }) => {
    assert.equal(await cli(["skill", "host", "add", "one"]), 1);
    assert.match(errors.join("\n"), /Usage: agent-depot skill host add/u);
    assert.equal(await cli(["skill", "host", "add", "one", "two", "--host", "claude"]), 1);
    assert.equal(await cli(["skill", "host", "add", "one", "--host", "nope"]), 1);
    assert.match(errors.join("\n"), /Unsupported or duplicate Host "nope"/u);
    assert.equal(await cli(["skill", "host", "add", "missing", "--host", "claude"]), 1);
    assert.match(errors.join("\n"), /Unknown user-global Skill "missing"/u);
    assert.equal(await cli(["skill", "host", "add", "one", "--host", "pi"]), 1);
    assert.match(errors.join("\n"), /already exposed to pi/u);
    assert.equal(await cli(["skill", "host", "list"]), 1);
  });
});

test("skill remove --host previews, then removes only the named host locations", async () => {
  await withSkill(["pi", "claude"], async ({ home, operations, lines, errors, cli }) => {
    assert.equal(await cli(["skill", "remove", "one", "--host", "claude"]), 1);
    assert.match(lines.join("\n"), /remove hosts claude from "portable\/one"/u);
    assert.match(errors.join("\n"), /not confirmed; rerun with --yes/u);
    assert.ok(await exists(claude(home)));

    assert.equal(await cli(["skill", "remove", "one", "--host", "claude", "--yes"]), 0);
    assert.equal(await exists(claude(home)), false);
    assert.ok(await exists(canonical(home)));
    assert.deepEqual(await hostsOf(operations), ["pi"]);
  });
});

test("skill remove --host for every recorded host is a full removal", async () => {
  await withSkill(["pi", "claude"], async ({ home, operations, lines, cli }) => {
    assert.equal(await cli(["skill", "remove", "one", "--host", "pi,claude", "--yes"]), 0);
    assert.equal(await exists(claude(home)), false);
    assert.equal(await exists(canonical(home)), false);
    assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
    assert.match(lines.join("\n"), /Removed 1 user-global Skill\b/u);
  });
});

test("skill remove --host rejects unrecorded hosts and multiple Skills", async () => {
  await withSkill(["pi", "claude"], async ({ home, operations, errors, cli }) => {
    assert.equal(await cli(["skill", "remove", "one", "--host", "codex", "--yes"]), 1);
    assert.match(errors.join("\n"), /Host codex is not recorded/u);
    assert.equal(await cli(["skill", "remove", "one", "two", "--host", "claude", "--yes"]), 1);
    assert.match(errors.join("\n"), /Usage: agent-depot skill remove/u);
    assert.ok(await exists(claude(home)));
    assert.deepEqual(await hostsOf(operations), ["pi", "claude"]);
  });
});
