import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppOperations, type AppEnvironment } from "../src/app-flow.js";

async function fixture(latest: unknown, fetch: typeof globalThis.fetch) {
  const home = await mkdtemp(path.join(tmpdir(), "app-updates-"));
  const recipesDirectory = path.join(home, "apps");
  await mkdir(recipesDirectory);
  await writeFile(path.join(recipesDirectory, "example.json"), JSON.stringify({
    name: "example", install: { manual: "install" }, update: { argv: ["example", "update"] },
    uninstall: { manual: "remove" }, version: { argv: ["example", "version"], pattern: "(\\d+\\.\\d+\\.\\d+)" }, latest,
  }));
  let version = "1.0.0";
  const environment: AppEnvironment = { homeDirectory: home, recipesDirectory, fetch,
    resolveExecutable: async () => "/bin/example",
    runner: async (_exe, args, options) => {
      assert.equal(options?.cwd, home);
      assert.equal(options?.maxStderrBytes, 1024 * 1024);
      if (args[0] === "update") version = "2.0.0";
      return { code: 0, signal: null, stdout: Buffer.from(version), stderr: "", outputTooLarge: false };
    } };
  const apps = createAppOperations(environment);
  const [entry] = await apps.load();
  return { home, apps, entry: entry!, environment };
}

test("approved GitHub latest check offers an update and execution records verified version", async () => {
  const f = await fixture({ github: "owner/repo" }, async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/owner/repo/releases/latest");
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    assert.deepEqual(options?.headers, { Accept: "application/json" });
    return new Response(JSON.stringify({ tag_name: "v2.0.0" }));
  });
  try {
    await f.apps.approve(f.entry);
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "update available");
    assert.equal((await f.apps.executeLifecycle(await f.apps.planLifecycle(f.entry, "update"), true)).status, "installed");
    assert.equal((await f.apps.trackedApps())[0]?.installedVersion, "2.0.0");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("npm lookup distinguishes current from unknown without real network", async () => {
  let response = new Response(JSON.stringify({ version: "1.0.0" }));
  const f = await fixture({ npm: "@scope/example" }, async url => {
    assert.equal(url, "https://registry.npmjs.org/%40scope%2Fexample/latest");
    return response;
  });
  try {
    await f.apps.approve(f.entry);
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "current");
    for (const body of ["bad JSON", JSON.stringify({ version: "" }), "x".repeat(1024 * 1024 + 1)]) {
      response = new Response(body);
      assert.equal((await f.apps.checkUpdate(f.entry)).status, "unknown");
    }
    response = new Response("rate limited", { status: 429 });
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "unknown");
    const broken = createAppOperations({ ...f.environment, fetch: async () => { throw new Error("offline"); } });
    assert.equal((await broken.checkUpdate(f.entry)).status, "unknown");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("latest argv requires unchanged approval and uses bounded home execution", async () => {
  const f = await fixture({ argv: ["example", "latest"], pattern: "(\\d+\\.\\d+\\.\\d+)" }, async () => { throw new Error("no HTTP expected"); });
  try {
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "unknown");
    await f.apps.approve(f.entry);
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "current");
    await writeFile(f.entry.file, "{}");
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "unknown");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("CLI existing update batch selects Apps and continues after an App failure", async () => {
  const f = await fixture({ npm: "example" }, async () => new Response(JSON.stringify({ version: "2.0.0" })));
  try {
    const { runCli } = await import("../src/cli.js");
    const { createSourceOperations } = await import("../src/sources.js");
    await f.apps.approve(f.entry);
    await writeFile(path.join(f.home, "apps", "second.json"), JSON.stringify({ ...f.entry.recipe, name: "second", update: { argv: ["second", "update"] } }));
    const apps = createAppOperations({ ...f.environment, resolveExecutable: async name => `/bin/${name}`, runner: async (exe, args) => ({
      code: exe === "/bin/example" && args[0] === "update" ? 2 : 0, signal: null, stdout: Buffer.from("1.0.0"), stderr: "failed", outputTooLarge: false,
    }) });
    const second = (await apps.load()).find(entry => entry.recipe?.name === "second")!;
    await apps.approve(second);
    const lines: string[] = [];
    const deps = { appOperations: apps, homeDirectory: f.home,
      operations: createSourceOperations({ statePath: path.join(f.home, "sources.json") }),
      stdout: (line: string) => lines.push(line), stderr: (line: string) => lines.push(line) };
    assert.equal(await runCli(["update", "check", "--scope", "user-global"], deps), 0);
    assert.ok(lines.some(line => line.includes("App example") && line.includes("update available")));
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--app", "example", "--app", "second", "--yes"], deps), 1);
    assert.ok(lines.some(line => line.includes("App second: installed")));
    assert.ok(lines.some(line => line.includes("Update summary: 1 updated, 1 failed")));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("app update CLI previews, confirms and checks manual completion", async () => {
  const f = await fixture(undefined, async () => { throw new Error("no network"); });
  try {
    const { runCli } = await import("../src/cli.js");
    await f.apps.approve(f.entry);
    const lines: string[] = [];
    const deps = { appOperations: f.apps, stdout: (line: string) => lines.push(line), stderr: (line: string) => lines.push(line) };
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "unknown");
    assert.equal(await runCli(["app", "update", "example"], deps), 1);
    assert.deepEqual(await f.apps.trackedApps(), []);
    assert.ok(lines.some(line => line.includes('App example update: ["example","update"]')));
    assert.equal(await runCli(["app", "update", "example", "--yes"], deps), 0);
    assert.equal((await f.apps.trackedApps())[0]?.installedVersion, "2.0.0");
    await writeFile(f.entry.file, JSON.stringify({ ...f.entry.recipe, update: { manual: "update yourself" } }));
    const [entry] = await f.apps.load();
    await f.apps.approve(entry!);
    assert.equal(await runCli(["app", "update", "example", "--yes"], deps), 1);
    assert.ok(lines.some(line => line.includes("Manual (never executed): update yourself")));
    assert.equal(await runCli(["app", "update", "example", "--manual-done", "--yes"], deps), 0);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("batch all applies approved Apps, subset excludes others and project rejects Apps", async () => {
  const f = await fixture({ npm: "example" }, async () => new Response(JSON.stringify({ version: "2.0.0" })));
  try {
    const { runCli } = await import("../src/cli.js");
    const { createSourceOperations } = await import("../src/sources.js");
    await f.apps.approve(f.entry);
    const lines: string[] = [];
    const deps = { appOperations: f.apps, homeDirectory: f.home,
      operations: createSourceOperations({ statePath: path.join(f.home, "sources.json") }),
      stdout: (line: string) => lines.push(line), stderr: (line: string) => lines.push(line) };
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--all"], deps), 1);
    assert.deepEqual(await f.apps.trackedApps(), []);
    assert.equal(await runCli(["update", "apply", "--scope", "project", "--app", "example", "--yes"], deps), 1);
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--app", "missing", "--yes"], deps), 1);
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--all", "--yes"], deps), 0);
    assert.ok(lines.some(line => line.includes("Update summary: 1 updated, 0 failed")));
    assert.equal((await f.apps.trackedApps())[0]?.installedVersion, "2.0.0");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("HTTP timeout and truncated bodies are unknown, never update candidates", async () => {
  const f = await fixture({ github: "owner/repo" }, async () => new Promise<Response>(() => {}));
  try {
    await f.apps.approve(f.entry);
    assert.equal((await f.apps.checkUpdate(f.entry)).status, "unknown");
    const brokenBody = createAppOperations({ ...f.environment, fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection lost")); },
    })) });
    assert.equal((await brokenBody.checkUpdate(f.entry)).status, "unknown");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("one existing batch selects a real built-in Skill and an App together", async () => {
  const f = await fixture({ npm: "example" }, async () => new Response(JSON.stringify({ version: "2.0.0" })));
  try {
    const { runCli } = await import("../src/cli.js");
    const { createSourceOperations } = await import("../src/sources.js");
    const operations = createSourceOperations({ statePath: path.join(f.home, "sources.json") });
    await f.apps.approve(f.entry);
    const lines: string[] = [];
    const deps = { appOperations: f.apps, homeDirectory: f.home, operations,
      stdout: (line: string) => lines.push(line), stderr: (line: string) => lines.push(line) };
    assert.equal(await runCli(["install", "--scope", "user-global", "--source", "builtin:agent-depot",
      "--skill", "doctor-md-agents", "--host", "pi", "--version", "latest", "--portable-v1", "--yes"], deps), 0, lines.join("\n"));
    const [skill] = await operations.listUserGlobalInstallations!();
    await operations.updateUserGlobalInstallation!({ ...skill!, installation: { ...skill!.installation!,
      resolvedVersion: { kind: "builtin-package", version: "0.0.1" },
    } });
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--skill", "0", "--app", "example", "--yes"], deps), 0, lines.join("\n"));
    assert.ok(lines.some(line => line.includes("Updated Skill")));
    assert.ok(lines.some(line => line.includes("Update summary: 2 updated, 0 failed")));
    assert.equal((await f.apps.trackedApps())[0]?.installedVersion, "2.0.0");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("manual batch completion guidance safely quotes shell-active App names", async () => {
  const f = await fixture({ npm: "example" }, async () => new Response(JSON.stringify({ version: "2.0.0" })));
  try {
    const { runCli } = await import("../src/cli.js");
    const { createSourceOperations } = await import("../src/sources.js");
    const name = "example$(unexpected)";
    await writeFile(f.entry.file, JSON.stringify({ ...f.entry.recipe, name, update: { manual: "update yourself" } }));
    const [entry] = await f.apps.load();
    await f.apps.approve(entry!);
    const lines: string[] = [];
    assert.equal(await runCli(["update", "apply", "--scope", "user-global", "--all", "--yes"], {
      appOperations: f.apps, homeDirectory: f.home,
      operations: createSourceOperations({ statePath: path.join(f.home, "sources.json") }),
      stdout: line => lines.push(line), stderr: line => lines.push(line),
    }), 1);
    assert.ok(lines.some(line => line.includes("app update 'example$(unexpected)' --manual-done --yes")));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("a failed latest executable lookup remains unknown rather than aborting the check", async () => {
  const f = await fixture({ argv: ["latest-tool"], pattern: "(2.0.0)" }, async () => { throw new Error("no network"); });
  try {
    await f.apps.approve(f.entry);
    const apps = createAppOperations({ ...f.environment, resolveExecutable: async name => {
      if (name === "latest-tool") throw new Error("PATH unavailable");
      return "/bin/example";
    } });
    assert.equal((await apps.checkUpdate(f.entry)).status, "unknown");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});
