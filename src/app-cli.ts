import { PROJECT_HOSTS, type ProjectHost } from "./project-manifest.js";
import { APP_RECIPE_SCHEMA } from "./app-schema.js";
import { type AppOperations, type AppEntry, type AppLifecyclePlan } from "./app-flow.js";
import { CliUsageError } from "./usage-error.js";

export async function runAppCommand(
  values: readonly string[],
  apps: AppOperations,
  output: (line: string) => void,
): Promise<number> {
  const [command, ...args] = values;
  const usage = "Usage: agent-depot app schema|list; app validate <file>...; app approve <name> [--yes]; app install|update|uninstall <name> [--yes] [--manual-done]; app setup|teardown <name> --host <host>... [--yes] [--manual-done]; app uninstall <name> --forget [--yes] (--manual-done requires a declared manual step)";
  if (command === "schema" && args.length === 0) {
    output(JSON.stringify(APP_RECIPE_SCHEMA, null, 2));
    return 0;
  }
  if (command === "list" && args.length === 0) {
    for (const entry of await apps.load()) {
      if (entry.applicable || entry.error) await show(entry, true);
    }
    return 0;
  }
  if (command === "install" || command === "update" || command === "uninstall" || command === "setup" || command === "teardown") {
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

  async function show(entry: AppEntry, includeLatest = false) {
    const update = includeLatest ? await apps.checkUpdate(entry) : undefined;
    const result = update?.inspection ?? await apps.inspect(entry);
    const columns = [
      entry.recipe?.name ?? entry.file, result.status,
      result.installedVersion ?? "unknown", result.executable ?? "unresolved",
    ];
    if (update) {
      columns.push(`latest: ${update.latestVersion ?? "unknown"}`, update.status);
    }
    if (result.reason) columns.push(result.reason);
    output(columns.join("\t"));
  }
}

async function runLifecycle(
  action: AppLifecyclePlan["action"],
  args: readonly string[],
  apps: AppOperations,
  output: (line: string) => void,
  usage: string,
): Promise<number> {
  const hostAction = action === "setup" || action === "teardown";
  const hosts: ProjectHost[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--host") { remaining.push(args[index]!); continue; }
    const host = args[++index];
    if (!hostAction || !PROJECT_HOSTS.some(value => value === host) || hosts.includes(host as ProjectHost)) {
      throw new CliUsageError(usage);
    }
    hosts.push(host as ProjectHost);
  }
  if (hostAction && !hosts.length) throw new CliUsageError(usage);
  const flags = remaining.filter(arg => arg.startsWith("--"));
  const names = remaining.filter(arg => !arg.startsWith("--"));
  const confirmed = flags.includes("--yes");
  const done = flags.includes("--manual-done");
  const forget = flags.includes("--forget");
  const invalidSelection = names.length !== 1;
  const duplicateFlags = new Set(flags).size !== flags.length;
  const unknownFlag = flags.some(flag => !["--yes", "--manual-done", "--forget"].includes(flag));
  const incompatibleForget = forget && (action !== "uninstall" || done);
  if (invalidSelection || duplicateFlags || unknownFlag || incompatibleForget) {
    throw new CliUsageError(usage);
  }
  const name = names[0]!;
  if (forget) {
    const record = await apps.previewForget(name);
    output(`Forget App tracking only: ${name} (${record.file}); no recipe commands will run`);
    await apps.forgetApp(name, confirmed);
    output(`${name}: untracked`);
    return 0;
  }
  const entries = (await apps.load()).filter(entry => entry.applicable && entry.recipe?.name === name);
  if (entries.length !== 1) throw new Error("No unique applicable recipe found");
  // Validate and preview the whole selection before executing any Host.
  const plans = await Promise.all((hostAction ? hosts : [undefined]).map(
    host => apps.planLifecycle(entries[0]!, action, host),
  ));
  for (const plan of plans) showPlan(plan);
  if (!confirmed) throw new Error("App step not confirmed; rerun with --yes after reviewing the preview");
  let failed = false;
  for (const plan of plans) {
    try { if (await applyPlan(plan) !== 0) failed = true; }
    catch (error) {
      if (!hostAction) throw error;
      output(`${name} (${plan.host}): failed`);
      output(error instanceof Error ? error.message : String(error));
      failed = true;
    }
  }
  return failed ? 1 : 0;

  function showPlan(plan: AppLifecyclePlan) {
    output(`App ${name} ${action}${plan.host ? ` (${plan.host})` : ""}: ${plan.argv ? JSON.stringify(plan.argv) : "manual only"}\t${plan.executable ?? "unresolved"}\tcwd: ${plan.cwd}\tenvironment: ${plan.environment}`);
    if (plan.warning) output(plan.warning);
    if (plan.manual) output(`Manual (never executed): ${plan.manual}`);
  }

  async function applyPlan(plan: AppLifecyclePlan): Promise<number> {
    const result = done ? await apps.completeManual(plan, true) : await apps.executeLifecycle(plan, true);
    output(`${name}${plan.host ? ` (${plan.host})` : ""}: ${result.status}`);
    if (result.reason) output(result.reason);
    if (result.status === "manual required") {
      output(`Manual (never executed): ${result.manual}`);
      output(describeManualCompletion(plan));
    }
    return result.status === "installed" || result.status === "untracked" || result.status === "completed" ? 0 : 1;
  }
}

/** Copyable completion command for the platform's documented shell. */
export function describeManualCompletion(plan: AppLifecyclePlan): string {
  const name = plan.entry.recipe!.name;
  const quotedName = process.platform === "win32"
    ? "'" + name.replaceAll("'", "''") + "'"
    : "'" + name.replaceAll("'", "'\\''") + "'";
  const shell = process.platform === "win32" ? "PowerShell" : "POSIX shell";
  return `After completing it, run app ${plan.action} ${quotedName}${plan.host ? ` --host ${plan.host}` : ""} --manual-done --yes to check version (${shell}).`;
}
