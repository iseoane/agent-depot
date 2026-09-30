import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { ProjectSkillSelection } from "../src/project-manifest.js";
import {
  inspectUserGlobalSymlinkRemoval,
  removeUserGlobalSymlink,
  scanUserGlobalSkillInventory,
} from "../src/user-global-skill-inventory.js";

const SKILL_MD = "---\nname: dev\ndescription: Dev skill\n---\n\nBody\n";

interface Fixture {
  readonly home: string;
  /** A skill directory outside the global roots, like a local development repository. */
  readonly target: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-depot-symlink-home-"));
  const outside = await mkdtemp(path.join(tmpdir(), "agent-depot-symlink-dev-"));
  t.after(async () => {
    await Promise.all([home, outside].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const target = path.join(outside, "dev-skill");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), SKILL_MD);
  return { home, target };
}

async function link(home: string, root: ".agents" | ".claude", name: string, target: string): Promise<string> {
  const linkPath = path.join(home, root, "skills", name);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, "dir");
  return linkPath;
}

function managed(installationPath: string): ProjectSkillSelection {
  return {
    source: { kind: "builtin", id: "builtin:agent-depot" },
    path: "portable/dev",
    version: { policy: "latest" },
    hosts: ["pi"],
    installation: { path: installationPath, adopted: false },
  };
}

test("the inventory lists unmanaged symlinks separately and keeps them out of the removal candidates", async (t) => {
  const { home, target } = await fixture(t);
  const agentsLink = await link(home, ".agents", "dev", target);
  const claudeLink = await link(home, ".claude", "dev", target);

  const inventory = await scanUserGlobalSkillInventory({ homeDirectory: home });

  assert.deepEqual(
    inventory.symlinks.map((entry) => [entry.name, entry.path, entry.root, entry.target]),
    [["dev", agentsLink, "agents", target], ["dev", claudeLink, "claude", target]],
  );
  assert.deepEqual(inventory.unmanaged, []);
  assert.equal(inventory.skipped.length, 2);
});

test("removes only the symbolic link and keeps its target", async (t) => {
  const { home, target } = await fixture(t);
  const linkPath = await link(home, ".claude", "dev", target);

  const inspection = await inspectUserGlobalSymlinkRemoval(linkPath, { homeDirectory: home, managedInstallations: [] });
  assert.equal(inspection.target, target);
  await removeUserGlobalSymlink(inspection, { homeDirectory: home, managedInstallations: [] });

  await assert.rejects(lstat(linkPath), { code: "ENOENT" });
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), SKILL_MD);
});

test("refuses a real directory, a relative path and a managed location", async (t) => {
  const { home, target } = await fixture(t);
  const real = path.join(home, ".agents", "skills", "real");
  await mkdir(real, { recursive: true });
  await writeFile(path.join(real, "SKILL.md"), SKILL_MD);
  const linkPath = await link(home, ".claude", "dev", target);
  const options = { homeDirectory: home, managedInstallations: [] };

  await assert.rejects(inspectUserGlobalSymlinkRemoval(real, options), /must be a symbolic link/);
  await assert.rejects(inspectUserGlobalSymlinkRemoval("skills/dev", options), /exact normalized absolute global path/);
  await assert.rejects(
    inspectUserGlobalSymlinkRemoval(linkPath, { homeDirectory: home, managedInstallations: [managed(".claude/skills/dev")] }),
    /managed or aliases a managed installation/,
  );
  assert.ok((await lstat(linkPath)).isSymbolicLink());
});

test("does not remove a link that was replaced or retargeted after the inspection", async (t) => {
  const { home, target } = await fixture(t);
  const linkPath = await link(home, ".claude", "dev", target);
  const options = { homeDirectory: home, managedInstallations: [] };
  const inspection = await inspectUserGlobalSymlinkRemoval(linkPath, options);

  await rm(linkPath);
  await symlink(path.join(home, ".agents"), linkPath, "dir");

  await assert.rejects(removeUserGlobalSymlink(inspection, options), /changed before deletion/);
  assert.ok((await lstat(linkPath)).isSymbolicLink());
});

test("does not remove a link when the managed records changed after the inspection", async (t) => {
  const { home, target } = await fixture(t);
  const linkPath = await link(home, ".claude", "dev", target);
  const options = { homeDirectory: home, managedInstallations: [] };
  const inspection = await inspectUserGlobalSymlinkRemoval(linkPath, options);

  await assert.rejects(
    removeUserGlobalSymlink(inspection, {
      ...options,
      readManagedInstallations: async () => [managed(".claude/skills/dev")],
    }),
    /managed or aliases a managed installation/,
  );
  assert.ok((await lstat(linkPath)).isSymbolicLink());
});
