import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/cli.js";

const INSTALL_USAGE = "Usage: agent-depot install --scope <project|user-global> --source <id> --skill <path> --host <host>... --version <latest|version> [--ref <git-ref>] [--method <json>] --portable-v1 [--overwrite --yes] [--confirm-additional-host]";

async function failure(argv: readonly string[]): Promise<string> {
  const errors: string[] = [];
  const code = await runCli(argv, {
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
    operations: {
      listSources: async () => [],
      addGitSource: async () => { throw new Error("unexpected"); },
      refreshSource: async () => { throw new Error("unexpected"); },
    } as never,
  });
  assert.equal(code, 1);
  assert.equal(errors.length, 1);
  return errors[0]!;
}

const selected = ["--source", "s", "--skill", "p", "--host", "pi"];

test("install option parsing reports precise usage errors", async () => {
  const cases: ReadonlyArray<readonly [readonly string[], string]> = [
    [["install"], "Error: Installation scope must be explicit: use --scope project or --scope user-global"],
    [["install", "--scope", "elsewhere"], "Error: Installation scope must be explicit: use --scope project or --scope user-global"],
    [["install", "--bogus"], `Error: ${INSTALL_USAGE}`],
    [["install", "--scope"], "Error: Missing value for --scope"],
    [["install", "--scope", "--yes"], "Error: Missing value for --scope"],
    [["install", "--scope", "project", "--source"], "Error: Missing value for --source"],
    [["install", "--scope", "project", "--host", "pi,pi"], 'Error: Unsupported or duplicate Host "pi"'],
    [["install", "--scope", "project", "--host", "nope"], 'Error: Unsupported or duplicate Host "nope"'],
    [["install", "--scope", "project", "--method", "{"], "Error: --method must be valid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"],
    [["install", "--scope", "user-global", "--manifest"], "Error: --manifest is only supported with --scope project"],
    [["install", "--scope", "project", "--manifest", "--source", "s"], "Error: --manifest cannot be combined with --source, --skill, --host, --version, --ref, --method, or --overwrite"],
    [["install", "--scope", "project", "--manifest", "--overwrite"], "Error: --manifest cannot be combined with --source, --skill, --host, --version, --ref, --method, or --overwrite"],
    [["install", "--scope", "project", ...selected], "Error: --version is required for a selected Skill"],
    [["install", "--scope", "project", "--ref", "main"], "Error: --version is required for a selected Skill"],
    [["install", "--scope", "project"], `Error: ${INSTALL_USAGE}`],
    [["install", "--scope", "project", "--version", "fixed:"], "Error: --version fixed:<value> must provide a non-empty version without whitespace or control characters"],
    [["install", "--scope", "project", "--version", "fixed:a b"], "Error: --version fixed:<value> must provide a non-empty version without whitespace or control characters"],
    [["install", "--scope", "project", "--version", "a\u0007b"], "Error: --version fixed:<value> must provide a non-empty version without whitespace or control characters"],
  ];
  for (const [argv, expected] of cases) {
    const message = await failure(argv);
    if (expected.includes("in JSON at position")) {
      assert.match(message, /^Error: --method must be valid JSON: /u);
    } else {
      assert.equal(message, expected, argv.join(" "));
    }
  }
});
