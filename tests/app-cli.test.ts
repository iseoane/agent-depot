import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { createAppOperations } from "../src/app-flow.js";

test("CLI schema, validation approval and listing use the shared core", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-cli-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const file = path.join(root, "example.json");
    await writeFile(file, JSON.stringify({
      name: "example",
      install: { argv: ["example", "install"] },
      update: { manual: "update" },
      uninstall: { manual: "remove" },
      version: {
        argv: ["example", "--version"],
        pattern: "(1.2.3)"
      },
      latest: {
        argv: ["example", "latest"],
        pattern: "(2.0.0)"
      },
      setup: { pi: { argv: ["example", "setup"] } }
    }));
    let calls = 0;
    const appOperations = createAppOperations({
      recipesDirectory: root,
      resolveExecutable: async () => "/usr/bin/example",
      runner: async () => {
        calls++;
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from("1.2.3"),
          stderr: "",
          outputTooLarge: false
        };
      }
    });
    const lines: string[] = [];
    const deps = {
      appOperations,
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line)
    };
    assert.equal(await runCli(["app", "schema"], deps), 0);
    assert.equal(JSON.parse(lines.join("\n")).type, "object");
    lines.length = 0;
    assert.equal(await runCli(["app", "validate", file], deps), 0);
    assert.equal(calls, 0);
    assert.ok(lines.some(line => line.includes("latest")));
    assert.ok(lines.some(line => line.includes("setup.pi")));
    lines.length = 0;
    assert.equal(await runCli(["app", "validate", file, "--yes"], deps), 1);
    assert.equal(calls, 0);
    assert.equal(await runCli(["app", "approve", "example"], deps), 0);
    assert.equal(calls, 0);
    assert.equal((await appOperations.inspect((await appOperations.load())[0]!)).status, "needs approval");
    assert.equal(await runCli(["app", "approve", "example", "--yes"], deps), 0);
    assert.equal(calls, 1);
    assert.equal(await runCli(["app", "list"], deps), 0);
    assert.ok(lines.some(line => line === ["example", "installed", "1.2.3", "/usr/bin/example"].join("\t")));
    assert.ok(lines.includes("Manual (never executed): update"));
    assert.equal(await runCli(["app", "list", "--yes"], deps), 1);
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("validate reports invalid and other-platform files without running commands", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-cli-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const other = path.join(root, "other.json");
    const invalid = path.join(root, "invalid.json");
    await writeFile(other, JSON.stringify({
      name: "other",
      platform: "windows",
      install: { manual: "install" },
      update: { manual: "update" },
      uninstall: { manual: "remove" },
      version: {
        argv: ["other", "--version"],
        pattern: "(v1)"
      }
    }));
    await writeFile(invalid, "{broken");
    const appOperations = createAppOperations({
      recipesDirectory: root,
      platform: "linux",
      runner: async () => {
        assert.fail("must not run");
      }
    });
    const lines: string[] = [];
    assert.equal(await runCli(["app", "validate", other, invalid], {
      appOperations,
      stdout: line => lines.push(line)
    }), 1);
    assert.ok(lines.some(line => line.includes("not applicable here")));
    assert.ok(lines.some(line => line.includes("invalid")));
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("approval of an unknown name is a normal failure, and CLI rejects extra arguments", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-cli-errors-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const appOperations = createAppOperations({ recipesDirectory: root });
    const errors: string[] = [];
    const deps = {
      appOperations,
      stdout: () => {
      },
      stderr: (line: string) => errors.push(line)
    };
    assert.equal(await runCli(["app", "approve", "missing", "--yes"], deps), 1);
    assert.match(errors.pop()!, /^Error: No applicable recipe found$/u);
    for (const args of [
      ["schema", "extra"],
      ["schema", "--unknown"],
      ["list", "extra"],
      ["list", "--unknown"],
      ["approve"],
      ["approve", "one", "two"],
      ["approve", "one", "--unknown"],
      ["approve", "one", "--yes", "--yes"],
      ["validate"],
      ["validate", "one", "--unknown"],
    ]) {
      assert.equal(await runCli(["app", ...args], deps), 1);
      assert.match(errors.pop()!, /^Error: Usage:/u);
    }
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("list is empty for a missing directory and shows invalid recipes with reasons", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-cli-list-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const lines: string[] = [];
    assert.equal(await runCli(["app", "list"], {
      appOperations: createAppOperations({ recipesDirectory: path.join(root, "missing") }),
      stdout: line => lines.push(line),
    }), 0);
    assert.equal(lines.length, 0);
    await writeFile(path.join(root, "broken.json"), "{broken");
    await writeFile(path.join(root, "unsupported.json"), JSON.stringify({ extra: true }));
    assert.equal(await runCli(["app", "list"], {
      appOperations: createAppOperations({ recipesDirectory: root }),
      stdout: line => lines.push(line),
    }), 0);
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => line.split("\t")[1] === "invalid" && line.split("\t")[4]));
    assert.ok(lines.some(line => line.includes("recipe.extra: unsupported recipe field")));
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("CLI preview explicitly flags Windows executables on WSL", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-cli-wsl-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const file = path.join(root, "recipe.json");
    await writeFile(file, JSON.stringify({
      name: "example",
      install: { manual: "install" },
      update: { manual: "update" },
      uninstall: { manual: "remove" },
      version: {
        argv: ["example", "--version"],
        pattern: "(v1)"
      },
    }));
    const lines: string[] = [];
    assert.equal(await runCli(["app", "validate", file], {
      appOperations: createAppOperations({
        recipesDirectory: root,
        isWsl: true,
        resolveExecutable: async () => "/mnt/c/x",
        runner: async () => {
          assert.fail("must not run");
        },
      }),
      stdout: line => lines.push(line),
    }), 0);
    assert.ok(lines.includes("will not run (Windows executable on WSL)"));
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("CLI install previews before confirmation and manual completion checks without rerunning", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "app-cli-lifecycle-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  try {
    await writeFile(path.join(directory, "example.json"), JSON.stringify({
      name: "example", install: { argv: ["example", "install"], manual: "install yourself" },
      update: { manual: "update" }, uninstall: { manual: "remove yourself" },
      version: { argv: ["example", "--version"], pattern: "(1\\.2\\.3)" },
    }));
    const calls: string[][] = [];
    let installed = true;
    const apps = createAppOperations({ recipesDirectory: directory, homeDirectory: home, isWsl: false,
      resolveExecutable: async () => "/usr/bin/example",
      runner: async (_command, args, options) => {
        calls.push([...args]);
        assert.equal(options?.cwd, home);
        if (args[0] === "install") throw Object.assign(new Error("cannot spawn"), { code: "ENOENT" });
        return { code: installed ? 0 : 1, signal: null, stdout: Buffer.from("1.2.3"),
          stderr: "", outputTooLarge: false };
      },
    });
    const lines: string[] = [];
    const deps = { appOperations: apps, stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line) };
    assert.equal(await runCli(["app", "install", "example", "--yes"], deps), 1);
    assert.deepEqual(calls, []);
    await apps.approve((await apps.load())[0]!);
    assert.equal(await runCli(["app", "install", "example"], deps), 1);
    assert.deepEqual(calls, []);
    assert.ok(lines.some(line => line.includes('["example","install"]') && line.includes("/usr/bin/example")));
    assert.ok(lines.some(line => line.includes(home) && line.includes(process.platform)));
    assert.equal(await runCli(["app", "install", "example", "--yes"], deps), 1);
    assert.ok(lines.some(line => line.includes("install yourself")));
    assert.ok(lines.some(line => line.includes("--manual-done")));
    assert.deepEqual(calls, [["install"]]);
    assert.equal(await runCli(["app", "install", "example", "--manual-done", "--yes"], deps), 0);
    assert.deepEqual(calls, [["install"], ["--version"]]);
    assert.equal((await apps.trackedApps()).length, 1);
    assert.equal(await runCli(["app", "uninstall", "example", "--yes"], deps), 1);
    assert.equal(await runCli(["app", "uninstall", "example", "--manual-done", "--yes"], deps), 1);
    assert.equal((await apps.trackedApps()).length, 1);
    installed = false;
    assert.equal(await runCli(["app", "uninstall", "example", "--manual-done", "--yes"], deps), 0);
    assert.deepEqual(await apps.trackedApps(), []);
    installed = true;
    await runCli(["app", "install", "example", "--manual-done", "--yes"], deps);
    const beforeForget = calls.length;
    assert.equal(await runCli(["app", "uninstall", "example", "--forget"], deps), 1);
    assert.equal((await apps.trackedApps()).length, 1);
    assert.equal(await runCli(["app", "uninstall", "example", "--forget", "--yes"], deps), 0);
    assert.equal(calls.length, beforeForget);
    assert.deepEqual(await apps.trackedApps(), []);
    for (const args of [
      ["install", "example", "--forget", "--yes"], ["install", "example", "--unknown"],
      ["install", "example", "--yes", "--yes"], ["uninstall", "example", "--forget", "--manual-done", "--yes"],
      ["install"], ["install", "example", "extra"],
    ]) assert.equal(await runCli(["app", ...args], deps), 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
