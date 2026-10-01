import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fakeAppFixture } from "./fake-app-fixture.js";

const cliPath = path.resolve("dist/src/cli.js");

test("built CLI approves, installs, updates, wires and uninstalls Apps hermetically", { skip: process.platform === "win32" }, async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "depot-app-e2e-"));
  try {
    const home = path.join(sandbox, "home");
    await mkdir(home);
    const fixture = await fakeAppFixture(sandbox);
    const env = { PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`, HOME: home,
      XDG_STATE_HOME: path.join(sandbox, "state"), XDG_CONFIG_HOME: path.join(sandbox, "config"), XDG_CACHE_HOME: path.join(sandbox, "cache") };
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: sandbox, env, encoding: "utf8" });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    assert.match(cli("app", "validate", fixture.file).output, /needs approval/);
    assert.match(cli("app", "list").output, /needs approval/);
    assert.equal(cli("app", "install", "fixture-app", "--yes").status, 1);
    await assert.rejects(readFile(fixture.log), { code: "ENOENT" });
    assert.equal(cli("app", "approve", "fixture-app", "--yes").status, 0);
    assert.equal(cli("app", "validate", fixture.file).status, 0);
    await writeFile(fixture.file, JSON.stringify(fixture.recipe) + "\n");
    const before = await readFile(fixture.log, "utf8");
    assert.match(cli("app", "list").output, /needs approval/);
    assert.equal(cli("app", "install", "fixture-app", "--yes").status, 1);
    assert.equal(await readFile(fixture.log, "utf8"), before);
    assert.equal(cli("app", "approve", "fixture-app", "--yes").status, 0);
    const ok = (...args: string[]) => {
      const result = cli(...args);
      assert.equal(result.status, 0, result.output);
      return result.output;
    };
    const records = async () => {
      try { return await readdir(path.join(fixture.stateDirectory, "app-installations")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    };
    // A successful lifecycle exit is insufficient without version evidence.
    await writeFile(fixture.file, JSON.stringify({ ...fixture.recipe, install: { argv: ["depot-e2e-app", "broken-install"] } }));
    ok("app", "approve", "fixture-app", "--yes");
    assert.equal(cli("app", "install", "fixture-app", "--yes").status, 1);
    assert.deepEqual(await records(), []);
    await writeFile(fixture.file, JSON.stringify(fixture.recipe));
    ok("app", "approve", "fixture-app", "--yes");
    assert.equal(cli("app", "install", "fixture-app").status, 1);
    await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
    ok("app", "install", "fixture-app", "--yes");
    assert.equal(await readFile(fixture.state, "utf8"), "1.0.0");
    const installedRecords = await records();
    assert.equal(installedRecords.length, 1);
    const recordFile = path.join(fixture.stateDirectory, "app-installations", installedRecords[0]!);
    assert.equal(JSON.parse(await readFile(recordFile, "utf8")).installedVersion, "1.0.0");
    assert.match(ok("app", "list"), /fixture-app\tinstalled\t1\.0\.0/);
    assert.match(ok("update", "check", "--scope", "user-global"), /fixture-app/);
    assert.match(ok("update", "apply", "--scope", "user-global", "--app", "fixture-app", "--yes"), /1 updated, 0 failed/);
    assert.equal(await readFile(fixture.state, "utf8"), "2.0.0");
    assert.equal(JSON.parse(await readFile(recordFile, "utf8")).installedVersion, "2.0.0");
    assert.match(ok("app", "list"), /fixture-app\tinstalled\t2\.0\.0/);
    for (const action of ["setup", "teardown"]) {
      const result = cli("app", action, "fixture-app", "--host", "claude", "--host", "pi", "--yes");
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /claude.*failed/);
      assert.match(result.output, /pi.*completed/);
    }
    ok("app", "uninstall", "fixture-app", "--yes");
    assert.deepEqual(await records(), []);
    await assert.rejects(readFile(fixture.state), { code: "ENOENT" });
    // Missing executable offers manual instructions, but never invents success.
    await writeFile(fixture.file, JSON.stringify({ ...fixture.recipe, install: {
      argv: ["depot-e2e-missing-executable", "install"], manual: "Run the fixture installer yourself"
    } }));
    ok("app", "approve", "fixture-app", "--yes");
    const fallback = cli("app", "install", "fixture-app", "--yes");
    assert.equal(fallback.status, 1);
    assert.match(fallback.output, /Manual .*Run the fixture installer yourself/);
    assert.match(fallback.output, /--manual-done/);
    assert.equal(cli("app", "install", "fixture-app", "--manual-done", "--yes").status, 1);
    assert.deepEqual(await records(), []);
    const manual = spawnSync("depot-e2e-app", ["install"], { cwd: home, env });
    assert.equal(manual.status, 0);
    ok("app", "install", "fixture-app", "--manual-done", "--yes");
    assert.equal((await records()).length, 1);
    ok("app", "uninstall", "fixture-app", "--yes");
    assert.deepEqual(await records(), []);
    const log: Array<{ argv: string[]; cwd: string }> = (await readFile(fixture.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(log.every(entry => entry.cwd === home));
    for (const action of ["setup", "teardown"]) {
      assert.deepEqual(log.filter(entry => entry.argv[0] === action).map(entry => entry.argv[1]), ["claude", "pi"]);
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
