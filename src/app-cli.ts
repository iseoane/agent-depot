import { APP_RECIPE_SCHEMA } from "./app-schema.js";
import { type AppOperations, type AppEntry } from "./app-flow.js";
import { CliUsageError } from "./usage-error.js";

export async function runAppCommand(
  values: readonly string[],
  apps: AppOperations,
  output: (line: string) => void,
): Promise<number> {
  const [command, ...args] = values;
  const usage = "Usage: agent-depot app schema|list; app validate <file>...; app approve <name> [--yes]";
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
