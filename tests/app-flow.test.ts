import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir, chmod, symlink, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppOperations } from "../src/app-flow.js";
const recipe = {
  name: "example",
  install: { manual: "install" },
  update: { manual: "update" },
  uninstall: { manual: "remove" },
  version: {
    argv: ["example", "--version"],
    pattern: "(\\d+\\.\\d+\\.\\d+)"
  }
};

test("approval permits version checks, but changed content never runs", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-test-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const file = path.join(root, "example.json");
    await writeFile(file, JSON.stringify(recipe));
    let calls = 0;
    const apps = createAppOperations({
      recipesDirectory: root,
      homeDirectory: root,
      resolveExecutable: async () => "/usr/bin/example",
      runner: async (_command, _args, options) => {
        calls++;
        assert.equal(options?.cwd, root);
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from("example 1.2.3"),
          stderr: "",
          outputTooLarge: false
        };
      }
    });
    const [entry] = await apps.load();
    assert.equal((await apps.inspect(entry!)).status, "needs approval");
    assert.equal(calls, 0);
    await apps.approve(entry!);
    assert.equal((await apps.inspect(entry!)).installedVersion, "1.2.3");
    await writeFile(file, JSON.stringify({
      ...recipe,
      homepage: "https://example.org"
    }));
    assert.equal((await apps.inspect(entry!)).status, "needs approval");
    assert.equal(calls, 1);
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("platform selection rejects applicable duplicates and isolates WSL executables", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-test-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    await writeFile(path.join(root, "one.json"), JSON.stringify(recipe));
    await writeFile(path.join(root, "two.json"), JSON.stringify({
      ...recipe,
      platform: "windows"
    }));
    let calls = 0;
    const apps = createAppOperations({
      recipesDirectory: root,
      platform: "linux",
      isWsl: true,
      resolveExecutable: async () => "/mnt/c/npm/example",
      runner: async () => {
        calls++;
        throw new Error("must not run");
      }
    });
    let entries = await apps.load();
    assert.equal(entries.filter(entry => entry.applicable).length, 1);
    await apps.approve(entries[0]!);
    assert.equal((await apps.inspect(entries[0]!)).status, "not installed");
    assert.equal(calls, 0);
    await writeFile(path.join(root, "two.json"), JSON.stringify({
      ...recipe,
      platform: "linux"
    }));
    entries = await apps.load();
    assert.ok(entries.every(entry => entry.error?.includes("Duplicate")));
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("a duplicate added after approval blocks even a previously loaded entry", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-test-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    await writeFile(path.join(root, "one.json"), JSON.stringify(recipe));
    let calls = 0;
    const apps = createAppOperations({
      recipesDirectory: root,
      resolveExecutable: async () => "/usr/bin/example",
      runner: async () => {
        calls++;
        throw new Error("must not run");
      }
    });
    const [entry] = await apps.load();
    await apps.approve(entry!);
    await writeFile(path.join(root, "two.json"), JSON.stringify(recipe));
    assert.equal((await apps.inspect(entry!)).status, "invalid");
    assert.equal(calls, 0);
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("version spawn failure, non-zero exit, oversized output and unmatched output mean not installed", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-test-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    await writeFile(path.join(root, "one.json"), JSON.stringify(recipe));
    for (const outcome of ["spawn", "exit", "size", "pattern", "missing"] as const) {
      const apps = createAppOperations({
        recipesDirectory: root,
        resolveExecutable: async () => outcome === "missing" ? undefined : "/usr/bin/example",
        runner: async () => {
          if (outcome === "spawn")
            throw new Error("ENOENT");
          return {
            code: outcome === "exit" ? 1 : 0,
            signal: null,
            stdout: Buffer.from(outcome === "pattern" ? "unknown" : "1.2.3"),
            stderr: "",
            outputTooLarge: outcome === "size"
          };
        }
      });
      const [entry] = await apps.load();
      await apps.approve(entry!);
      assert.equal((await apps.inspect(entry!)).status, "not installed", outcome);
    }
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("WSL skips Windows PATH hits and spawns the Linux shim rather than its realpath", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-resolution-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  const previousPath = process.env.PATH;
  try {
    const windows = path.join(root, "mnt", "c", "bin");
    const linux = path.join(root, "linux");
    await mkdir(windows, { recursive: true });
    await mkdir(linux);
    await writeFile(path.join(windows, "example"), "windows");
    await chmod(path.join(windows, "example"), 493);
    const binary = path.join(root, "multicall");
    await writeFile(binary, "linux");
    await chmod(binary, 493);
    await symlink(binary, path.join(linux, "example"));
    await writeFile(path.join(root, "recipe.json"), JSON.stringify(recipe));
    process.env.PATH = [windows, linux].join(path.delimiter);
    let calls = 0;
    const apps = createAppOperations({
      recipesDirectory: root,
      homeDirectory: path.join(root, "home"),
      platform: "linux",
      isWsl: true,
      wslMountRoot: path.join(root, "mnt"),
      runner: async (command, args, options) => {
        calls++;
        assert.equal(command, path.join(linux, "example"));
        assert.deepEqual(args, ["--version"]);
        assert.equal(options?.cwd, path.join(root, "home"));
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from("1.2.3"),
          stderr: "",
          outputTooLarge: false
        };
      },
    });
    const [entry] = await apps.load();
    await apps.approve(entry!);
    assert.equal((await apps.inspect(entry!)).installedVersion, "1.2.3");
    assert.equal((await apps.inspect(entry!)).executable, path.join(linux, "example"));
    assert.equal(calls, 2);
    await rm(path.join(linux, "example"));
    assert.equal((await apps.inspect(entry!)).status, "not installed");
    assert.equal(calls, 2);
  } finally {
    if (previousPath === undefined)
      delete process.env.PATH;
    else
      process.env.PATH = previousPath;
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("external validation is independent of apps-directory duplicates", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-external-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const directory = path.join(root, "apps");
    await mkdir(directory);
    await writeFile(path.join(directory, "registered.json"), JSON.stringify(recipe));
    const external = path.join(root, "external.json");
    await writeFile(external, JSON.stringify(recipe));
    const apps = createAppOperations({ recipesDirectory: directory });
    const [entry] = await apps.load([external]);
    assert.equal(entry!.error, undefined);
    assert.equal((await apps.inspect(entry!)).status, "needs approval");
    await writeFile(path.join(directory, "duplicate.json"), JSON.stringify(recipe));
    const [internal] = await apps.load([path.join(directory, "registered.json")]);
    assert.match(internal!.error!, /Duplicate/u);
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("approval receipts use canonical file identity and private atomic storage", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-receipt-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const directory = path.join(root, "apps");
    await mkdir(directory);
    const file = path.join(directory, "recipe.json");
    const alias = path.join(root, "alias.json");
    await writeFile(file, JSON.stringify(recipe));
    await symlink(file, alias);
    const apps = createAppOperations({
      recipesDirectory: directory,
      resolveExecutable: async () => "/usr/bin/example",
      runner: async () => ({
        code: 0,
        signal: null,
        stdout: Buffer.from("1.2.3"),
        stderr: "",
        outputTooLarge: false
      }),
    });
    const [entry] = await apps.load();
    await apps.approve(entry!);
    const [aliased] = await apps.load([alias]);
    assert.equal((await apps.inspect(aliased!)).status, "installed");
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(root, "app-approvals"))).mode & 511, 448);
    }
    await Promise.all([apps.approve(entry!), apps.approve(entry!)]);
    const receipts = await readdir(path.join(root, "app-approvals"));
    assert.equal(receipts.length, 1);
    assert.ok(receipts[0]!.endsWith(".json"));
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(root, "app-approvals", receipts[0]!))).mode & 511, 384);
    }
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("WSL mount boundaries and previews distinguish Windows drive mounts", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-boundary-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const directory = path.join(root, "apps");
    await mkdir(directory);
    await writeFile(path.join(directory, "recipe.json"), JSON.stringify(recipe));
    for (const executable of ["/mnt/c/x", "/mnt/data/x", "/mntc/x"]) {
      let calls = 0;
      const apps = createAppOperations({
        recipesDirectory: directory,
        isWsl: true,
        resolveExecutable: async () => executable,
        runner: async () => {
          calls++;
          return {
            code: 0,
            signal: null,
            stdout: Buffer.from("1.2.3"),
            stderr: "",
            outputTooLarge: false
          };
        },
      });
      const [entry] = await apps.load();
      const versionPreview = (await apps.preview(entry!)).find(step => step.step === "version")!;
      assert.equal(versionPreview.warning, executable === "/mnt/c/x" ? "will not run (Windows executable on WSL)" : undefined);
      await apps.approve(entry!);
      assert.equal((await apps.inspect(entry!)).status, executable === "/mnt/c/x" ? "not installed" : "installed");
      assert.equal(calls, executable === "/mnt/c/x" ? 0 : 1);
    }
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("approval survives rereads and byte restoration, but no changed recipe command runs", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-bytes-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const directory = path.join(root, "apps");
    await mkdir(directory);
    const file = path.join(directory, "recipe.json");
    const bytes = JSON.stringify(recipe);
    await writeFile(file, bytes);
    let calls = 0;
    const apps = createAppOperations({
      recipesDirectory: directory,
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
      },
    });
    const [original] = await apps.load();
    await apps.approve(original!);
    const [reread] = await apps.load();
    assert.equal((await apps.inspect(reread!)).status, "installed");
    await writeFile(file, bytes + " ");
    assert.equal((await apps.inspect(original!)).status, "needs approval");
    const [changed] = await apps.load();
    assert.equal((await apps.inspect(changed!)).status, "needs approval");
    assert.equal(calls, 1);
    await writeFile(file, "{broken");
    assert.equal((await apps.inspect(original!)).status, "invalid");
    assert.equal(calls, 1);
    await writeFile(file, bytes);
    const [restored] = await apps.load();
    assert.equal((await apps.inspect(restored!)).status, "installed");
    assert.equal(calls, 2);
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("platform-free and matching recipes apply on Windows and Darwin", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-platform-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    for (const platform of ["win32", "darwin"] as const) {
      const file = path.join(root, "recipe.json");
      const apps = createAppOperations({
        recipesDirectory: root,
        platform
      });
      await writeFile(file, JSON.stringify(recipe));
      assert.equal((await apps.load())[0]!.applicable, true);
      await writeFile(file, JSON.stringify({
        ...recipe,
        platform: platform === "win32" ? "windows" : "darwin"
      }));
      assert.equal((await apps.load())[0]!.applicable, true);
    }
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("approval preview includes exactly all argv and only the version reaches the runner", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-preview-"));
  const root = path.join(fixture, "workspace");
  await mkdir(root);
  try {
    const directory = path.join(root, "apps");
    const home = path.join(root, "home");
    await mkdir(directory);
    const file = path.join(directory, "recipe.json");
    const declaration = {
      ...recipe,
      install: { argv: ["example", "install"] },
      update: {
        argv: ["example", "update"],
        manual: "update manually"
      },
      uninstall: { argv: ["example", "remove"] },
      setup: { pi: { argv: ["example", "setup", "pi"] } },
      teardown: { claude: { argv: ["example", "teardown", "claude"] } },
    };
    const executed: unknown[] = [];
    const apps = createAppOperations({
      recipesDirectory: directory,
      homeDirectory: home,
      resolveExecutable: async () => "/usr/bin/example",
      runner: async (command, args, options) => {
        executed.push([command, args, options?.cwd]);
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from("1.2.3"),
          stderr: "",
          outputTooLarge: false
        };
      },
    });
    for (const latest of [
      {
        argv: ["example", "latest"],
        pattern: "(v2)"
      },
      { npm: "example" },
      { github: "owner/repo" },
    ]) {
      await writeFile(file, JSON.stringify({
        ...declaration,
        latest
      }));
      const [entry] = await apps.load();
      const preview = await apps.preview(entry!);
      const expected = [
        ["install", ["example", "install"]],
        ["update", ["example", "update"]],
        ["uninstall", ["example", "remove"]],
        ["version", ["example", "--version"]],
        ...("argv" in latest ? [["latest", ["example", "latest"]]] : []),
        ["setup.pi", ["example", "setup", "pi"]],
        ["teardown.claude", ["example", "teardown", "claude"]],
      ];
      assert.deepEqual(preview.filter(step => step.argv).map(step => [step.step, step.argv]), expected);
      assert.ok(preview.every(step => step.cwd === home && step.executable === "/usr/bin/example"));
      assert.equal(executed.length, 0);
    }
    await writeFile(file, JSON.stringify(recipe));
    const [manual] = await apps.load();
    await apps.preview(manual!);
    await apps.approve(manual!);
    await apps.inspect(manual!);
    assert.deepEqual(executed, [["/usr/bin/example", ["--version"], home]]);
  } finally {
    await rm(fixture, {
      recursive: true,
      force: true
    });
  }
});

test("approval repairs permissions on an existing approval directory", {
  skip: process.platform === "win32" ? "Windows does not enforce POSIX directory modes" : false,
}, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "app-receipt-mode-"));
  try {
    const directory = path.join(fixture, "apps");
    const receipts = path.join(fixture, "app-approvals");
    await mkdir(directory);
    await mkdir(receipts);
    await chmod(receipts, 0o755);
    await writeFile(path.join(directory, "recipe.json"), JSON.stringify(recipe));
    const apps = createAppOperations({ recipesDirectory: directory });
    const [entry] = await apps.load();
    await apps.approve(entry!);
    assert.equal((await stat(receipts)).mode & 0o777, 0o700);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
