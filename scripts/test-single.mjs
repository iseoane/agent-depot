import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_TEST = "tests/version.test.ts";

/** Maps a source test path (`tests/x.test.ts` or `.tsx`, `/` or `\` separators) to its compiled `dist/tests/x.test.js`. */
export function compiledTestPath(input = DEFAULT_TEST) {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!/^tests\/.+\.tsx?$/iu.test(normalized)) {
    throw new Error(`Expected a test source path under tests/ ending in .ts or .tsx, got ${JSON.stringify(input)}`);
  }
  return `dist/${normalized.replace(/\.tsx?$/iu, ".js")}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let file;
  try {
    file = compiledTestPath(process.argv[2]);
  } catch (error) {
    console.error(`test:single: ${error.message}`);
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`test:single: compiled test ${file} does not exist; check the path of ${process.argv[2] ?? DEFAULT_TEST}`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, ["--import", "./dist/tests/isolated-env.js", "--test", file], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
