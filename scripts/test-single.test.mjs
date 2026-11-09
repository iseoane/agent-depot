import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compiledTestPath } from "./test-single.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("maps .ts and .tsx test sources to compiled files with either separator", () => {
  assert.equal(compiledTestPath("tests/atomic-file.test.ts"), "dist/tests/atomic-file.test.js");
  assert.equal(compiledTestPath("tests/tui-profile.test.tsx"), "dist/tests/tui-profile.test.js");
  assert.equal(compiledTestPath("tests\\atomic-file.test.ts"), "dist/tests/atomic-file.test.js");
  assert.equal(compiledTestPath("./tests/e2e/journey.e2e.test.ts"), "dist/tests/e2e/journey.e2e.test.js");
  assert.equal(compiledTestPath(), "dist/tests/version.test.js");
});

test("rejects paths outside tests/ or without a TypeScript extension", () => {
  assert.throws(() => compiledTestPath("src/cli.ts"), /under tests\//u);
  assert.throws(() => compiledTestPath("tests/atomic-file.test.js"), /\.ts or \.tsx/u);
});

test("fails clearly with a non-zero exit when the compiled test is missing", () => {
  const result = spawnSync(process.execPath, ["scripts/test-single.mjs", "tests/does-not-exist.test.ts"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dist\/tests\/does-not-exist\.test\.js does not exist/u);
});
