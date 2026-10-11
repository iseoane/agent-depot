import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { createSelfUpdateOperations, type SelfUpdateOperations } from "../src/self-update.js";

interface Fixture {
  readonly root: string;
  readonly packageRoot: string;
  readonly projectRoot: string;
  readonly globalRoot: string;
  readonly npmPath: string;
  readonly calls: { readonly executable: string; readonly args: readonly string[] }[];
  readonly fetchUrls: string[];
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-self-update-"));
  const packageRoot = path.join(root, "global", "node_modules", "@iseoane", "agent-depot");
  const projectRoot = path.join(root, "project");
  const globalRoot = path.join(root, "global", "node_modules");
  const npmPath = path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(path.dirname(npmPath), { recursive: true });
  await writeFile(npmPath, "fixture executable");
  const calls: { executable: string; args: readonly string[] }[] = [];
  const fetchUrls: string[] = [];
  return { root, packageRoot, projectRoot, globalRoot, npmPath, calls, fetchUrls };
}

function operations(
  setup: Fixture,
  options: { readonly packageRoot?: string; readonly packageVersion?: string; readonly latest?: string; readonly rootExitCode?: number; readonly installExitCode?: number; readonly executable?: string } = {},
) {
  return createSelfUpdateOperations({
    packageName: "@iseoane/agent-depot",
    packageVersion: options.packageVersion ?? "0.5.1",
    packageRoot: options.packageRoot ?? setup.packageRoot,
    resolveExecutable: async () => ({ executable: options.executable ?? setup.npmPath, blocked: false }),
    run: async (executable, args) => {
      setup.calls.push({ executable, args });
      return args[0] === "root"
        ? {
            code: options.rootExitCode ?? 0,
            signal: null,
            stdout: Buffer.from(setup.globalRoot),
            stderr: "",
            outputTooLarge: false,
          }
        : { code: options.installExitCode ?? 0, signal: null, stdout: Buffer.alloc(0), stderr: "", outputTooLarge: false };
    },
    fetch: async (input) => {
      setup.fetchUrls.push(String(input));
      return new Response(JSON.stringify({ version: options.latest ?? "0.6.0" }), { status: 200 });
    },
  });
}

test("checks npm global provenance before reading the registry and pins a confirmed update", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));

  const selfUpdate = operations(setup);
  assert.deepEqual(await selfUpdate.check(), { kind: "available", current: "0.5.1", latest: "0.6.0" });
  assert.deepEqual(setup.fetchUrls, ["https://registry.npmjs.org/@iseoane%2Fagent-depot/latest"]);
  assert.deepEqual(setup.calls[0]?.args, ["root", "--global", "--silent", "--logs-max=0", "--no-update-notifier"]);

  await selfUpdate.apply("0.6.0");
  assert.deepEqual(setup.calls[2], {
    executable: setup.npmPath,
    args: [
      "install", "--global", "--no-audit", "--no-fund", "--no-update-notifier", "--logs-max=0", "--ignore-scripts",
      "--registry=https://registry.npmjs.org/", "@iseoane/agent-depot@0.6.0",
    ],
  });
});

test("refuses npm-path shims whose global package root is not this installation", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const selfUpdate = operations(setup, { packageRoot: setup.root });

  assert.deepEqual(await selfUpdate.check(), {
    kind: "unsupported",
    reason: "this CLI is not verified in npm's global package directory",
  });
  assert.deepEqual(setup.fetchUrls, []);
  await assert.rejects(selfUpdate.apply("0.6.0"), /not verified in npm's global package directory/u);
  assert.equal(setup.calls.length, 2);
  assert.ok(setup.calls.every(({ args }) => args[0] === "root"));
});

test("refuses npm-linked local Git checkouts even when npm reports the link as global", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  await rm(setup.packageRoot, { recursive: true });
  await mkdir(setup.projectRoot);
  await symlink(setup.projectRoot, setup.packageRoot, process.platform === "win32" ? "junction" : "dir");

  assert.deepEqual(await operations(setup, { packageRoot: setup.projectRoot }).check(), {
    kind: "unsupported",
    reason: "this CLI is not verified in npm's global package directory",
  });
  assert.deepEqual(setup.calls.map(({ args }) => args[0]), ["root"]);
  assert.deepEqual(setup.fetchUrls, []);
});

test("does not trust an arbitrary npm PATH shim as installation provenance", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const shim = path.join(setup.root, "bin", "npm");
  await mkdir(path.dirname(shim), { recursive: true });
  await writeFile(shim, "arbitrary PATH shim");

  assert.deepEqual(await operations(setup, { executable: shim }).check(), {
    kind: "unsupported",
    reason: "this CLI is not verified in npm's global package directory",
  });
  assert.deepEqual(setup.calls, []);
  assert.deepEqual(setup.fetchUrls, []);
});

test("treats current, prerelease, and older registry versions without downgrading", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));

  assert.deepEqual(await operations(setup, { latest: "0.5.1+registry.1" }).check(), {
    kind: "current", current: "0.5.1", latest: "0.5.1+registry.1",
  });
  assert.deepEqual(await operations(setup, { packageVersion: "1.0.0-rc.1", latest: "1.0.0-rc.2" }).check(), {
    kind: "available", current: "1.0.0-rc.1", latest: "1.0.0-rc.2",
  });
  assert.deepEqual(await operations(setup, { packageVersion: "1.0.0", latest: "0.9.9" }).check(), {
    kind: "ahead", current: "1.0.0", latest: "0.9.9",
  });
});

test("rejects invalid registry versions and npm root failures before any install", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));

  const invalid = operations(setup, { latest: "01.2.3" });
  await assert.rejects(invalid.check(), /Invalid semantic version/u);
  await assert.rejects(invalid.apply("01.2.3"), /Refusing invalid Agent Depot version/u);
  await assert.rejects(invalid.apply("0.5.0"), /Refusing to downgrade/u);
  assert.equal(setup.calls.length, 1);

  const failedRoot = operations(setup, { rootExitCode: 1 });
  assert.equal((await failedRoot.check()).kind, "unsupported");
  assert.ok(setup.calls.every(({ args }) => args[0] === "root"));
});

test("previews without applying until --yes and gives manual guidance when unsupported", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const calls: string[] = [];
  const available: SelfUpdateOperations = {
    async check() { return { kind: "available", current: "0.5.1", latest: "0.6.0" }; },
    async apply(version) { calls.push(version); },
  };
  const dependencies = { selfUpdateOperations: available, stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line) };

  assert.equal(await runCli(["self-update"], dependencies), 1);
  assert.match(output.join("\n"), /Preview: update Agent Depot from 0\.5\.1 to 0\.6\.0/u);
  assert.match(output.join("\n"), /--ignore-scripts.*--registry=https:\/\/registry\.npmjs\.org/u);
  assert.match(errors.join("\n"), /rerun with --yes/u);
  assert.equal(calls.length, 0);

  output.length = 0;
  errors.length = 0;
  assert.equal(await runCli(["self-update", "--yes"], dependencies), 0);
  assert.deepEqual(calls, ["0.6.0"]);

  output.length = 0;
  const current: SelfUpdateOperations = {
    async check() { return { kind: "current", current: "0.6.0", latest: "0.6.0" }; },
    async apply(version) { calls.push(version); },
  };
  assert.equal(await runCli(["self-update"], {
    selfUpdateOperations: current,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  }), 0);
  assert.deepEqual(calls, ["0.6.0"]);
  assert.deepEqual(output, ["Agent Depot 0.6.0 is current"]);

  output.length = 0;
  const unsupported: SelfUpdateOperations = {
    async check() { return { kind: "unsupported", reason: "unknown manager" }; },
    async apply() { throw new Error("unsupported update must not run"); },
  };
  assert.equal(await runCli(["self-update", "--yes"], {
    selfUpdateOperations: unsupported,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  }), 0);
  assert.match(output.join("\n"), /package manager that installed it/u);
  assert.match(output.join("\n"), /pnpm add --global/u);

  output.length = 0;
  errors.length = 0;
  const failedUpdate: SelfUpdateOperations = {
    async check() { return { kind: "available", current: "0.5.1", latest: "0.6.0" }; },
    async apply() { throw new Error("npm global update exited with code 1"); },
  };
  assert.equal(await runCli(["self-update", "--yes"], {
    selfUpdateOperations: failedUpdate,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  }), 1);
  assert.equal(output.some((line) => line.startsWith("Updated Agent Depot")), false);
  assert.match(errors.join("\n"), /npm global update exited with code 1/u);
});

test("reports npm update failures instead of claiming success", async (t) => {
  const setup = await fixture();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const selfUpdate = operations(setup, { installExitCode: 1 });
  assert.deepEqual(await selfUpdate.check(), { kind: "available", current: "0.5.1", latest: "0.6.0" });
  await assert.rejects(selfUpdate.apply("0.6.0"), /npm global update exited with code 1/u);
  assert.equal(setup.calls.at(-1)?.args[0], "install");
});

test("rejects unknown self-update arguments", async () => {
  const errors: string[] = [];
  assert.equal(await runCli(["self-update", "--force"], { stderr: (line) => errors.push(line) }), 1);
  assert.match(errors.join("\n"), /Usage: agent-depot self-update/u);
});
