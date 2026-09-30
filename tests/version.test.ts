import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { AGENT_DEPOT_PACKAGE_VERSION } from "../src/project-manifest.js";

// Compiled location: dist/tests -> package.json two levels up.
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

async function packageJsonVersion(): Promise<string> {
  return (JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as { version: string }).version;
}

test("the package version is a semantic version read from package.json", async () => {
  assert.match(AGENT_DEPOT_PACKAGE_VERSION ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(AGENT_DEPOT_PACKAGE_VERSION, await packageJsonVersion());
});

for (const flag of ["--version", "-v"]) {
  test(`${flag} prints only the package version and exits 0`, async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runCli([flag], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
    assert.equal(code, 0);
    assert.deepEqual(output, [await packageJsonVersion()]);
    assert.deepEqual(errors, []);
  });
}

test("--version does not accept extra arguments", async () => {
  const errors: string[] = [];
  const code = await runCli(["--version", "extra"], { stdout: () => undefined, stderr: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /Usage:/);
});

for (const flag of ["--help", "-h", "help"]) {
  test(`${flag} prints the usage to stdout without an error prefix and exits 0`, async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runCli([flag], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
    assert.equal(code, 0);
    assert.equal(output.length, 1);
    assert.match(output[0] ?? "", /^Usage:\n {2}agent-depot source list/);
    assert.deepEqual(errors, []);
  });
}

test("a bare invocation and help with extra arguments stay usage errors", async () => {
  for (const argv of [[], ["--help", "extra"]]) {
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runCli(argv, { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
    assert.equal(code, 1);
    assert.deepEqual(output, []);
    assert.match(errors.join("\n"), /^Error: Usage:/);
  }
});
