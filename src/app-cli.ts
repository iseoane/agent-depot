import { APP_RECIPE_SCHEMA } from "./app-schema.js";
import { type AppOperations, type AppEntry } from "./app-flow.js";
import { CliUsageError } from "./usage-error.js";

export async function runAppCommand(
  values: readonly string[],
  apps: AppOperations,
  output: (line: string) => void,
): Promise<number> {
  const [command, ...args] = values;
  const usage = "Usage: agent-depot app schema|list; app validate <file>...; app approve <name> [--yes]; app install|uninstall <name> [--yes] [--manual-done]; app uninstall <name> --forget [--yes]";
  if (command === "schema" && args.length === 0) {
    output(JSON.stringify(APP_RECIPE_SCHEMA, null, 2));
    return 0;
  }
  if (command === "list" && args.length === 0) {
    for (const entry of await apps.load()) {
      if (entry.applicable || entry.error) await show(entry);
    }
    return 0;
  }
  if (command === "install" || command === "uninstall") {
    return runLifecycle(command, args, apps, output, usage);
  }
  if (command !== "validate" && command !== "approve") throw new CliUsageError(usage);
  const confirmations = args.filter((arg) => arg === "--yes").length;
  const selections = command === "approve" ? args.filter((arg) => arg !== "--yes") : args;
  if (!selections.length || selections.some((arg) => arg.startsWith("--"))
    || confirmations > 1 || (command === "approve" && selections.length !== 1)) {
    throw new CliUsageError(usage);
  }
  const entries = command === "validate"
    ? await apps.load(selections)
    : (await apps.load()).filter((entry) => entry.recipe?.name === selections[0] && entry.applicable);
  if (!entries.length) throw new Error("No applicable recipe found");
  let failed = false;
  for (const entry of entries) {
    if (entry.error) {
      await show(entry);
      failed = true;
      continue;
    }
    if (!entry.applicable) {
      await show(entry);
      continue;
    }
    output(`Recipe approval preview: ${entry.recipe!.name} (${entry.file})`);
    for (const preview of await apps.preview(entry)) {
      const argv = preview.argv ? JSON.stringify(preview.argv) : "manual only";
      output(`${preview.step}: ${argv}\t${preview.executable ?? "unresolved"}\tcwd: ${preview.cwd}`);
      if (preview.warning) output(preview.warning);
      if ("manual" in preview && preview.manual) {
        output(`Manual (never executed): ${preview.manual}`);
      }
    }
    if (command === "approve" && confirmations === 1) {
      await apps.approve(entry);
    } else {
      output(`Approve explicitly with app approve ${JSON.stringify(entry.recipe!.name)} --yes after reviewing every argv.`);
    }
    await show(entry);
  }
  return failed ? 1 : 0;

  async function show(entry: AppEntry) {
    const result = await apps.inspect(entry);
    const columns = [
      entry.recipe?.name ?? entry.file, result.status,
      result.installedVersion ?? "unknown", result.executable ?? "unresolved",
    ];
    if (result.reason) columns.push(result.reason);
    output(columns.join("\t"));
  }
}

async function runLifecycle(
  action: "install" | "uninstall",
  args: readonly string[],
  apps: AppOperations,
  output: (line: string) => void,
  usage: string,
): Promise<number> {
  const flags = args.filter(arg => arg.startsWith("--"));
  const names = args.filter(arg => !arg.startsWith("--"));
  const confirmed = flags.includes("--yes");
  const done = flags.includes("--manual-done");
  const forget = flags.includes("--forget");
  if (names.length !== 1 || new Set(flags).size !== flags.length
    || flags.some(flag => !["--yes", "--manual-done", "--forget"].includes(flag))
    || (forget && (action !== "uninstall" || done))) throw new CliUsageError(usage);
  const name = names[0]!;
  if (forget) {
    const record = (await apps.trackedApps()).find(app => app.name === name);
    if (!record) throw new Error("No tracked App found");
    output(`Forget App tracking only: ${name} (${record.recipeFile}); no recipe commands will run`);
    await apps.forgetApp(name, confirmed);
    output(`${name}: untracked`);
    return 0;
  }
  const entries = (await apps.load()).filter(entry => entry.applicable && entry.recipe?.name === name);
  if (entries.length !== 1) throw new Error("No unique applicable recipe found");
  const plan = await apps.planLifecycle(entries[0]!, action);
  output(`App ${name} ${action}: ${plan.argv ? JSON.stringify(plan.argv) : "manual only"}\t${plan.executable ?? "unresolved"}\tcwd: ${plan.cwd}\tenvironment: ${plan.environment}`);
  if (plan.warning) output(plan.warning);
  if (plan.manual) output(`Manual (never executed): ${plan.manual}`);
  if (!confirmed) throw new Error("App step not confirmed; rerun with --yes after reviewing the preview");
  const result = done ? await apps.completeManual(plan, true) : await apps.executeLifecycle(plan, true);
  output(`${name}: ${result.status}`);
  if (result.reason) output(result.reason);
  if (result.status === "manual required") {
    output(`Manual (never executed): ${result.manual}`);
    output(`After completing it, run app ${action} ${JSON.stringify(name)} --manual-done --yes to check version.`);
  }
  return result.status === "installed" || result.status === "untracked" ? 0 : 1;
}
