#!/usr/bin/env node
// Packs the package, checks the tarball contents, installs it into a clean
// directory and runs the installed CLI against a temporary HOME.
// Requires a prior `pnpm build`. Never publishes anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sandbox = mkdtempSync(path.join(tmpdir(), "agent-depot-pack-"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...options });

try {
  const packDirectory = path.join(sandbox, "pack");
  mkdirSync(packDirectory);
  const [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", packDirectory], { cwd: root }));
  const files = packed.files.map((file) => file.path);
  console.log(`Tarball ${packed.filename}: ${files.length} files`);
  for (const file of files) console.log(`  ${file}`);

  const allowedTopLevel = /^(dist\/src\/|skills\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/u;
  const unexpected = files.filter((file) => !allowedTopLevel.test(file));
  assert.deepEqual(unexpected, [], `unexpected files in tarball: ${unexpected.join(", ")}`);
  const forbidden = files.filter((file) => /(^|\/)(tests?|coverage|odd|\.scratch)\/|\.test\.(js|d\.ts|js\.map)$/u.test(file));
  assert.deepEqual(forbidden, [], `forbidden files in tarball: ${forbidden.join(", ")}`);
  // Source maps point at ../../src (not shipped); skill tests and fixtures are dev-only.
  const devOnly = files.filter((file) => /\.map$/u.test(file) || /(^|\/)test_[^/]*\.py$/u.test(file) || /(^|\/)testdata\//u.test(file));
  assert.deepEqual(devOnly, [], `dev-only files in tarball: ${devOnly.join(", ")}`);
  for (const required of ["dist/src/cli.js", "package.json", "README.md", "LICENSE", "CHANGELOG.md", "skills/doctor-md-agents/SKILL.md"]) {
    assert.ok(files.includes(required), `missing from tarball: ${required}`);
  }

  const installDirectory = path.join(sandbox, "install");
  const homeDirectory = path.join(sandbox, "home");
  mkdirSync(installDirectory);
  mkdirSync(homeDirectory);
  writeFileSync(path.join(installDirectory, "package.json"), JSON.stringify({ name: "pack-smoke", private: true }));
  run(npm, ["install", "--no-audit", "--no-fund", path.join(packDirectory, packed.filename)], { cwd: installDirectory });

  const env = { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory };
  const agentDepot = (...args) => {
    try {
      return { status: 0, output: run("npx", ["--no-install", "agent-depot", ...args], { cwd: installDirectory, env }) };
    } catch (error) {
      return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };

  const version = agentDepot("--version");
  assert.equal(version.status, 0, version.output);
  assert.equal(version.output.trim(), manifest.version);

  const help = agentDepot("--help");
  assert.match(help.output, /Usage:[\s\S]*agent-depot tui/u);

  const discovery = agentDepot("discover", "builtin:agent-depot");
  assert.equal(discovery.status, 0, discovery.output);
  assert.match(discovery.output, /doctor-md-agents/u);

  // The TUI entry point must load with Ink/React resolved from the installed dependencies.
  const tuiEntry = path.join(installDirectory, "node_modules", ...manifest.name.split("/"), "dist", "src", "tui", "render.js");
  run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${tuiEntry.replaceAll("\\", "/")}`)})`], { cwd: installDirectory, env });

  console.log(`Pack smoke test passed for ${manifest.name}@${manifest.version}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
