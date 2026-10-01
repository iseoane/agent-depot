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
