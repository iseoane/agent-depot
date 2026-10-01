import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** A real executable with sandbox-local version state and an audit log. No network. */
export async function fakeAppFixture(sandbox: string) {
  const bin = path.join(sandbox, "bin");
  const state = path.join(sandbox, "app-version");
  const log = path.join(sandbox, "app-log");
  const stateDirectory = path.join(sandbox, "state", "agent-depot");
  const recipes = path.join(stateDirectory, "apps");
  await mkdir(bin, { recursive: true });
  await mkdir(recipes, { recursive: true });
  const executable = path.join(bin, "depot-e2e-app");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const state = ${JSON.stringify(state)};
const log = ${JSON.stringify(log)};
const [action, host] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
switch (action) {
  case '--version': if (!fs.existsSync(state)) process.exit(1); console.log(fs.readFileSync(state, 'utf8')); break;
  case 'latest': console.log('2.0.0'); break;
  case 'install': fs.writeFileSync(state, '1.0.0'); break;
  case 'update': fs.writeFileSync(state, '2.0.0'); break;
  case 'uninstall': fs.rmSync(state, { force: true }); break;
  case 'setup': case 'teardown': if (host === 'claude') { console.error('host deliberately failed'); process.exit(1); } break;
  case 'broken-install': break;
  default: process.exit(2);
}
`);
  await chmod(executable, 0o755);
  const command = (action: string, ...args: string[]) => ({ argv: ["depot-e2e-app", action, ...args] });
  const recipe = {
    name: "fixture-app",
    install: command("install"), update: command("update"), uninstall: command("uninstall"),
    version: { ...command("--version"), pattern: "(\\d+\\.\\d+\\.\\d+)" },
    latest: { ...command("latest"), pattern: "(\\d+\\.\\d+\\.\\d+)" },
    setup: { claude: command("setup", "claude"), pi: command("setup", "pi") },
    teardown: { claude: command("teardown", "claude"), pi: command("teardown", "pi") },
  };
  const file = path.join(recipes, "fixture.json");
  await writeFile(file, JSON.stringify(recipe));
  return { bin, state, log, stateDirectory, file, recipe };
}
