#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const skills = ["doctor-md-agents", "doctor-md-skill"];

for (const skill of skills) {
  const scripts = path.join(root, "skills", skill, "scripts");
  const tests = path.join(root, "tests", "skills", skill);
  const env = {
    ...process.env,
    PYTHONPATH: [scripts, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: "1",
  };
  console.log(`\nRunning ${skill} tests`);
  const result = spawnSync(python, ["-m", "unittest", "discover", "-s", tests, "-p", "test_*.py"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Could not run Python for ${skill}: ${result.error.message}`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
