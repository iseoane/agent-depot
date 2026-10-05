import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createAppOperations } from "../src/app-flow.js";
import { planAppRecipeRemoval, removeAppRecipe } from "../src/app-recipe-removal.js";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "app-recipe-removal-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  const file = path.join(directory, "demo.json");
  const content = JSON.stringify({ name: "demo", install: { argv: ["demo", "install"] }, update: { argv: ["demo", "update"] },
    uninstall: { argv: ["demo", "uninstall"] }, version: { argv: ["demo", "version"], pattern: "(1\\.2\\.3)" } });
  await writeFile(file, content);
  let installed = false;
  const commands: string[] = [];
  const apps = createAppOperations({ homeDirectory: home, recipesDirectory: directory,
    resolveExecutable: async () => "/bin/demo", runner: async (_command, args) => {
      commands.push(args[0]);
      if (args[0] === "install") installed = true;
      if (args[0] === "uninstall") installed = false;
      return { code: args[0] === "version" && !installed ? 1 : 0, stdout: Buffer.from(installed ? "1.2.3" : ""), stderr: "", signal: null, outputTooLarge: false };
    },
  });
  const [entry] = await apps.load();
  return { home, file, content, entry, apps, commands };
}

test("removing an uninstalled recipe requires confirmation and deletes only its file", async () => {
  const f = await fixture();
  try {
    await f.apps.approve(f.entry);
    const plan = await planAppRecipeRemoval(f.apps, f.entry);
    assert.equal(plan.installed, false);
    await assert.rejects(removeAppRecipe(f.apps, plan, false), /confirmed/u);
    assert.equal(await readFile(f.file, "utf8"), f.content);
    await removeAppRecipe(f.apps, plan, true);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
    assert.ok(f.commands.every((command) => command === "version"));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("an installed App must be uninstalled before deleting its recipe", async () => {
  const f = await fixture();
  try {
    await f.apps.approve(f.entry);
    await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    const plan = await planAppRecipeRemoval(f.apps, f.entry);
    assert.equal(plan.installed, true);
    await assert.rejects(removeAppRecipe(f.apps, plan, true), /still installed or tracked/u);
    assert.equal(await readFile(f.file, "utf8"), f.content);
    const result = await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "uninstall"), true);
    assert.equal(result.status, "untracked");
    await removeAppRecipe(f.apps, plan, true);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("changed recipes and unapproved commands cannot be removed or executed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(planAppRecipeRemoval(f.apps, f.entry), /approve/u);
    assert.deepEqual(f.commands, []);
    await f.apps.approve(f.entry);
    const plan = await planAppRecipeRemoval(f.apps, f.entry);
    await writeFile(f.file, f.content + "\n");
    await assert.rejects(removeAppRecipe(f.apps, plan, true), /changed/u);
    assert.equal(await readFile(f.file, "utf8"), f.content + "\n");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("a recipe whose version command cannot run is not removable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "app-recipe-removal-unverified-"));
  try {
    const directory = path.join(home, "apps");
    await mkdir(directory);
    const file = path.join(directory, "demo.json");
    const content = JSON.stringify({ name: "demo", install: { argv: ["demo", "install"] }, update: { argv: ["demo", "update"] },
      uninstall: { argv: ["demo", "uninstall"] }, version: { argv: ["demo", "version"], pattern: "(1\\.2\\.3)" } });
    await writeFile(file, content);
    // A missing version executable leaves installed state unverified, so removal must fail closed.
    const apps = createAppOperations({ homeDirectory: home, recipesDirectory: directory,
      resolveExecutable: async () => undefined,
      runner: async () => { throw new Error("no lifecycle command may run"); },
    });
    const [entry] = await apps.load();
    await apps.approve(entry);
    await assert.rejects(planAppRecipeRemoval(apps, entry), /did not run/u);
    assert.equal(await readFile(file, "utf8"), content);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("removing a symlink recipe leaves its target intact", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, "original.json");
    await writeFile(target, f.content);
    await rm(f.file);
    await symlink(target, f.file);
    const [entry] = await f.apps.load();
    await f.apps.approve(entry);
    const plan = await planAppRecipeRemoval(f.apps, entry);
    await removeAppRecipe(f.apps, plan, true);
    assert.equal(await readFile(target, "utf8"), f.content);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
  } finally { await rm(f.home, { recursive: true, force: true }); }
});
