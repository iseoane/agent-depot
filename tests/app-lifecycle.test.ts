import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, chmod, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppOperations } from "../src/app-flow.js";
import type { AppRecipe } from "../src/app-recipes.js";
import type { runProcess } from "../src/process-runner.js";

const recipe: AppRecipe = {
  name: "example", install: { argv: ["example", "install"], manual: "install yourself" },
  update: { manual: "update" }, uninstall: { manual: "remove yourself" },
  version: { argv: ["example", "--version"], pattern: "(1\\.2\\.3)" },
};
const result = (stdout = "1.2.3", code = 0) => ({
  code, stdout: Buffer.from(stdout), stderr: "", signal: null, outputTooLarge: false,
});
async function fixture(runner: typeof runProcess, declaration = recipe) {
  const home = await mkdtemp(path.join(tmpdir(), "app-lifecycle-"));
  const directory = path.join(home, "apps");
  await mkdir(directory);
  const file = path.join(directory, "example.json");
  await writeFile(file, JSON.stringify(declaration));
  const environment = { isWsl: false, homeDirectory: home, recipesDirectory: directory,
    resolveExecutable: async () => "/usr/bin/example", runner };
  const apps = createAppOperations(environment);
  const [entry] = await apps.load();
  await apps.approve(entry!);
  return { home, file, apps, entry: entry!, environment };
}

test("confirmed install runs from home and persists only a verified version", async () => {
  const calls: unknown[] = [];
  const f = await fixture(async (command, args, options) => {
    calls.push([command, args, options?.cwd]);
    return result();
  });
  try {
    const plan = await f.apps.planLifecycle(f.entry, "install");
    assert.equal(plan.executable, "/usr/bin/example");
    assert.equal(plan.environment, process.platform);
    assert.deepEqual(calls, []);
    await assert.rejects(f.apps.executeLifecycle(plan, false), /confirm/iu);
    assert.equal((await f.apps.executeLifecycle(plan, true)).status, "installed");
    assert.deepEqual(calls, [
      ["/usr/bin/example", ["install"], f.home],
      ["/usr/bin/example", ["--version"], f.home],
    ]);
    assert.deepEqual(await createAppOperations(f.environment).trackedApps(), [
      { name: "example", recipeFile: f.entry.canonicalFile, installedVersion: "1.2.3" },
    ]);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("spawn failure guides manual completion; non-zero exit never falls back", async () => {
  let mode = "spawn";
  const f = await fixture(async (_command, args) => {
    if (args[0] === "--version") return result();
    if (mode === "spawn") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { ...result("failure output", 2), stderr: "diagnostic" };
  });
  try {
    const plan = await f.apps.planLifecycle(f.entry, "install");
    assert.equal((await f.apps.executeLifecycle(plan, true)).status, "manual required");
    assert.deepEqual(await f.apps.trackedApps(), []);
    await assert.rejects(f.apps.completeManual(plan, false), /completion/iu);
    assert.equal((await f.apps.completeManual(plan, true)).status, "installed");
    mode = "exit";
    const failure = await f.apps.executeLifecycle(plan, true);
    assert.equal(failure.status, "failed");
    assert.match(failure.reason!, /failure output.*diagnostic/u);
    assert.equal(failure.manual, undefined);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("manual uninstall retains tracking until version fails or explicit forget", async () => {
  let installed = true;
  const f = await fixture(async () => result(installed ? "1.2.3" : "", installed ? 0 : 1));
  try {
    await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    const plan = await f.apps.planLifecycle(f.entry, "uninstall");
    assert.equal((await f.apps.executeLifecycle(plan, true)).status, "manual required");
    assert.equal((await f.apps.completeManual(plan, true)).status, "failed");
    assert.equal((await f.apps.trackedApps()).length, 1);
    installed = false;
    assert.equal((await f.apps.completeManual(plan, true)).status, "untracked");
    assert.deepEqual(await f.apps.trackedApps(), []);
    assert.equal((await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true)).status, "failed");
    assert.deepEqual(await f.apps.trackedApps(), []);
    installed = true;
    await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    await assert.rejects(f.apps.forgetApp("example", false), /confirmation/u);
    await f.apps.forgetApp("example", true);
    assert.deepEqual(await f.apps.trackedApps(), []);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("changed approval or executable blocks previously previewed lifecycle and manual completion", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return result(); });
  try {
    const plan = await f.apps.planLifecycle(f.entry, "install");
    await writeFile(f.file, JSON.stringify({ ...recipe, homepage: "https://example.org" }));
    await assert.rejects(f.apps.executeLifecycle(plan, true), /approval/u);
    await assert.rejects(f.apps.completeManual(plan, true), /approval/u);
    const [changed] = await f.apps.load();
    await assert.rejects(f.apps.planLifecycle(changed!, "install"), /approval/u);
    assert.equal(calls, 0);
    await writeFile(f.file, JSON.stringify(recipe));
    const different = createAppOperations({ ...f.environment, resolveExecutable: async () => "/other/example" });
    await assert.rejects(different.executeLifecycle(plan, true), /changed/u);
    assert.equal(calls, 0);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("WSL blocked lifecycle executable never runs and offers declared manual guidance", async () => {
  const f = await fixture(async () => assert.fail("must not spawn"));
  try {
    const apps = createAppOperations({ ...f.environment, isWsl: true,
      resolveExecutable: async () => "/mnt/c/npm/example" });
    const plan = await apps.planLifecycle(f.entry, "install");
    assert.match(plan.warning!, /Windows/u);
    assert.equal((await apps.executeLifecycle(plan, true)).status, "manual required");
    assert.equal((await apps.completeManual(plan, true)).status, "failed");
    assert.deepEqual(await apps.trackedApps(), []);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("manual installation can make a previously missing executable available", async () => {
  const f = await fixture(async () => result());
  let available = false;
  try {
    const apps = createAppOperations({ ...f.environment,
      resolveExecutable: async () => available ? "/usr/bin/example" : undefined });
    const plan = await apps.planLifecycle(f.entry, "install");
    assert.equal((await apps.executeLifecycle(plan, true)).status, "manual required");
    available = true;
    assert.equal((await apps.completeManual(plan, true)).status, "installed");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("automated uninstall untracks only after version fails; missing command without manual fails", async () => {
  let installed = true;
  const f = await fixture(async (_command, args) => {
    if (args[0] === "remove") installed = false;
    return result(installed ? "1.2.3" : "", args[0] === "--version" && !installed ? 1 : 0);
  }, { ...recipe, uninstall: { argv: ["example", "remove"] } });
  try {
    await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    assert.equal((await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "uninstall"), true)).status, "untracked");
    assert.deepEqual(await f.apps.trackedApps(), []);
    const missing = createAppOperations({ ...f.environment, resolveExecutable: async () => undefined });
    assert.equal((await missing.executeLifecycle(await missing.planLifecycle(f.entry, "uninstall"), true)).status, "failed");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("only launch errors offer manual fallback; unexpected runner errors propagate", async () => {
  let code = "ENOENT";
  const f = await fixture(async () => { throw Object.assign(new Error("runner error"), { code }); });
  try {
    const plan = await f.apps.planLifecycle(f.entry, "install");
    for (code of ["ENOENT", "EACCES", "ENOEXEC", "EPERM"]) {
      assert.equal((await f.apps.executeLifecycle(plan, true)).status, "manual required");
    }
    code = "EIO";
    await assert.rejects(f.apps.executeLifecycle(plan, true), /runner error/u);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("oversized output and signals fail with bounded diagnostics and no tracking", async () => {
  let oversized = true;
  const f = await fixture(async () => ({ ...result("x".repeat(10000)),
    stderr: "y".repeat(10000), code: null, signal: "SIGTERM", outputTooLarge: oversized }));
  try {
    const plan = await f.apps.planLifecycle(f.entry, "install");
    const failure = await f.apps.executeLifecycle(plan, true);
    assert.equal(failure.status, "failed");
    assert.match(failure.reason!, /output exceeded 1048576/u);
    assert.ok(failure.reason!.length < 9000);
    assert.deepEqual(await f.apps.trackedApps(), []);
    oversized = false;
    assert.match((await f.apps.executeLifecycle(plan, true)).reason!, /SIGTERM/u);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});


test("App records repair directory permissions and hash traversal-like identities", async () => {
  const f = await fixture(async () => result(), { ...recipe, name: "../../other/app" });
  try {
    const directory = path.join(f.home, "app-installations");
    await mkdir(directory);
    await chmod(directory, 0o755);
    await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[a-f0-9]{64}\.json$/u);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(directory, files[0]!))).mode & 0o777, 0o600);
    }
    assert.equal((await f.apps.trackedApps())[0]!.name, "../../other/app");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("corrupt records are skipped with warnings and do not block explicit forget", async () => {
  const f = await fixture(async () => result());
  try {
    await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    const directory = path.join(f.home, "app-installations");
    await writeFile(path.join(directory, "broken.json"), "{broken");
    const warnings: string[] = [];
    assert.equal((await f.apps.trackedApps(warning => warnings.push(warning))).length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /broken.json/u);
    assert.match((await f.apps.previewForget("example")).file, /app-installations/u);
    await f.apps.forgetApp("example", true);
    assert.deepEqual(await f.apps.trackedApps(() => {}), []);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("Host lifecycle accepts only declared steps and leaves App tracking unchanged", async () => {
  const f = await fixture(async (_command, args, options) => {
    assert.equal(options?.cwd, f.home);
    assert.equal(options?.maxStderrBytes, 1048576);
    return result(args[0] === "--version" ? "1.2.3" : "");
  }, { ...recipe, setup: { pi: { argv: ["example", "setup"] } } });
  try {
    const plan = await f.apps.planLifecycle(f.entry, "setup", "pi");
    assert.equal(plan.host, "pi");
    await assert.rejects(f.apps.executeLifecycle(plan, false), /confirm/u);
    assert.equal((await f.apps.executeLifecycle(plan, true)).status, "completed");
    assert.deepEqual(await f.apps.trackedApps(), []);
    await assert.rejects(f.apps.planLifecycle(f.entry, "setup", "claude"), /declared/u);
    await assert.rejects(f.apps.planLifecycle(f.entry, "teardown", "pi"), /declared/u);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("Host manual completion checks version and approval without claiming wiring or changing tracking", async () => {
  let mode = "spawn";
  const f = await fixture(async (_command, args) => {
    if (args[0] === "--version") return result(mode === "absent" ? "" : "1.2.3");
    if (mode === "spawn") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return result("failure", 2);
  }, { ...recipe, teardown: { pi: { argv: ["example", "undo"], manual: "undo yourself" } } });
  try {
    const plan = await f.apps.planLifecycle(f.entry, "teardown", "pi");
    assert.equal((await f.apps.executeLifecycle(plan, true)).status, "manual required");
    await assert.rejects(f.apps.completeManual(plan, false), /completion/u);
    assert.equal((await f.apps.completeManual(plan, true)).status, "completed");
    mode = "exit";
    assert.equal((await f.apps.executeLifecycle(plan, true)).status, "failed");
    mode = "absent";
    assert.equal((await f.apps.completeManual(plan, true)).status, "failed");
    const changedResolver = createAppOperations({ ...f.environment, resolveExecutable: async () => "/other/example" });
    await assert.rejects(changedResolver.executeLifecycle(plan, true), /changed/u);
    await writeFile(f.file, JSON.stringify({ ...recipe, homepage: "changed" }));
    await assert.rejects(f.apps.executeLifecycle(plan, true), /approval/u);
    await assert.rejects(f.apps.completeManual(plan, true), /approval/u);
    assert.deepEqual(await f.apps.trackedApps(), []);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});


test("missing Homebrew identifies the installation prerequisite without running or tracking", async () => {
  const f = await fixture(async () => assert.fail("must not run without brew"), {
    ...recipe, name: "engram", install: { argv: ["brew", "install", "engram"] },
  });
  try {
    const apps = createAppOperations({ ...f.environment, resolveExecutable: async () => undefined });
    const outcome = await apps.executeLifecycle(await apps.planLifecycle(f.entry, "install"), true);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason!, /"brew" for install/u);
    assert.match(outcome.reason!, /Install Homebrew/u);
    assert.match(outcome.reason!, /PATH used by Agent Depot/u);
    assert.deepEqual(await apps.trackedApps(), []);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("manual-only steps explain manual completion rather than a missing executable", async () => {
  const f = await fixture(async () => assert.fail("manual step must not run"), {
    ...recipe, install: { manual: "Install CodeGraph yourself, then check its version" },
  });
  try {
    const outcome = await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "install"), true);
    assert.equal(outcome.status, "manual required");
    assert.match(outcome.reason!, /install step requires manual completion/u);
    assert.equal(outcome.manual, "Install CodeGraph yourself, then check its version");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});
