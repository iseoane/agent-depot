import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { createSourceOperations } from "../src/sources.js";
import { inspectUserGlobalSymlinkRemoval, scanUserGlobalSkillInventory } from "../src/user-global-skill-inventory.js";

const declaration = {
  name: "owner", install: { manual: "install" }, update: { manual: "update" },
  uninstall: { manual: "remove" }, version: { argv: ["owner"], pattern: "(.*)" },
  skills: ["doctor-md-*"],
};

test("CLI excludes App-owned skills from listing, adoption and explicit removal without running commands", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-owned-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const apps = path.join(home, ".local", "state", "agent-depot", "apps");
  await mkdir(apps, { recursive: true });
  await writeFile(path.join(apps, "owner.json"), JSON.stringify(declaration));
  const skill = path.join(home, ".agents", "skills", "doctor-md-agents");
  await cp(path.resolve("skills/doctor-md-agents"), skill, { recursive: true });
  const before = await lstat(skill);
  const operations = createSourceOperations({ homeDirectory: home, statePath: path.join(home, "sources.json") });
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies = { homeDirectory: home, operations, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };
  assert.equal(await runCli(["update", "check", "--scope", "user-global"], dependencies), 0);
  assert.doesNotMatch(output.join("\n"), /skills[/\\]doctor-md-agents/);
  assert.equal(await runCli(["install", "--scope", "user-global", "--source", "builtin:agent-depot", "--skill", "doctor-md-agents", "--host", "pi", "--version", "latest", "--portable-v1", "--yes"], dependencies), 1);
  assert.match(errors.join("\n"), /App-owned/);
  assert.equal(await runCli(["uninstall", "--unmanaged-skill", skill, "--yes"], dependencies), 1);
  assert.equal((await lstat(skill)).ino, before.ino);
  assert.deepEqual(await operations.listUserGlobalInstallations!(), []);
});

test("App-owned dangling symlinks are neither inspected nor removable", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-owned-link-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const apps = path.join(home, "apps");
  await mkdir(apps);
  await writeFile(path.join(apps, "owner.json"), JSON.stringify(declaration));
  const link = path.join(home, ".claude", "skills", "doctor-md-link");
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(path.join(home, "missing"), link, "dir");
  const options = { homeDirectory: home, managedInstallations: [], appEnvironment: { recipesDirectory: apps } };
  const inventory = await scanUserGlobalSkillInventory(options);
  assert.deepEqual(inventory.symlinks, []);
  assert.deepEqual(inventory.skipped, []);
  await assert.rejects(inspectUserGlobalSymlinkRemoval(link, options), /App-owned/);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test("a recipe added after removal preview protects the selected path at execution", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "ad-owned-recheck-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const skill = path.join(home, ".agents", "skills", "doctor-md-agents");
  await cp(path.resolve("skills/doctor-md-agents"), skill, { recursive: true });
  const { inspectUserGlobalSkillRemoval, removeUserGlobalSkill } = await import("../src/user-global-skill-inventory.js");
  const options = { homeDirectory: home, managedInstallations: [] };
  const inspection = await inspectUserGlobalSkillRemoval(skill, options);
  const apps = path.join(home, ".local", "state", "agent-depot", "apps");
  await mkdir(apps, { recursive: true });
  await writeFile(path.join(apps, "owner.json"), JSON.stringify(declaration));
  await assert.rejects(removeUserGlobalSkill(inspection, options), /App-owned/);
  assert.equal((await lstat(skill)).isDirectory(), true);
});
