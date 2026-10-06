import { readFile } from "node:fs/promises";
import type { AppOperations } from "./app-flow.js";
import { buildProfileExport, requireProfileExportSelection, writeProfileExport, type ProfileFilters } from "./profile-export.js";
import { applyProfileImport, buildProfileImport, type ProfileImportEnvironment } from "./profile-import.js";
import { serializeProfile, type ProfilePackageOperations } from "./profile.js";
import type { SourceOperations } from "./sources.js";
import { CliUsageError } from "./usage-error.js";

export const EXPORT_USAGE = "agent-depot export [--out <file>] [--no-sources] [--no-skills] [--no-apps] [--no-packages] [--source <id|url>...] [--skill <path|name>...] [--app <name>...] [--package <selection>...]";

export const IMPORT_USAGE = "agent-depot import <file> [--yes] [--no-sources] [--no-skills] [--no-apps] [--no-packages] [--source <id|url>...] [--skill <path|name>...] [--app <name>...] [--package <selection>...]";

export async function runProfileExport(values: readonly string[], operations: SourceOperations, apps: AppOperations,
  output: (line: string) => void, diagnostic: (line: string) => void, homeDirectory?: string,
  packageOperations?: ProfilePackageOperations): Promise<number> {
  const { filters, out } = parseProfileOptions(values, false);
  const plan = await buildProfileExport(operations, apps, {
    ...filters,
    homeDirectory,
    ...(packageOperations === undefined ? {} : { packageOperations }),
  });
  for (const line of plan.preview) diagnostic(line);
  requireProfileExportSelection(plan.profile);
  const content = serializeProfile(plan.profile);
  if (out === undefined) output(content.trimEnd());
  else {
    await writeProfileExport(out, plan.profile);
    diagnostic(`Exported profile to ${out}`);
  }
  return 0;
}

function parseProfileOptions(values: readonly string[], importing: boolean) {
  const sources: string[] = [], skills: string[] = [], appNames: string[] = [], packageNames: string[] = [];
  const filters: { -readonly [Key in keyof ProfileFilters]: ProfileFilters[Key] } = { sources, skills, apps: appNames, packages: packageNames };
  let out: string | undefined;
  let confirmed = false;
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === "--yes" && importing) {
      if (confirmed) throw new CliUsageError("Duplicate --yes");
      confirmed = true;
    } else if (option === "--no-sources") filters.noSources = true;
    else if (option === "--no-skills") filters.noSkills = true;
    else if (option === "--no-apps") filters.noApps = true;
    else if (option === "--no-packages") filters.noPackages = true;
    else if (["--out", "--source", "--skill", "--app", "--package"].includes(option!)) {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw new CliUsageError(`${option} requires a value`);
      if (option === "--out") {
        if (importing) throw new CliUsageError(`Usage: ${IMPORT_USAGE}`);
        if (out !== undefined) throw new CliUsageError("Duplicate --out");
        out = value;
      } else {
        const names = option === "--source" ? sources : option === "--skill" ? skills : option === "--app" ? appNames : packageNames;
        if (names.includes(value)) throw new CliUsageError(`Duplicate ${option} ${JSON.stringify(value)}`);
        names.push(value);
      }
    } else throw new CliUsageError(`Usage: ${importing ? IMPORT_USAGE : EXPORT_USAGE}`);
  }
  return { filters, out, confirmed };
}

export async function runProfileImport(values: readonly string[], operations: SourceOperations, apps: AppOperations,
  output: (line: string) => void, environment: ProfileImportEnvironment = {}): Promise<number> {
  const file = values[0];
  if (!file || file.startsWith("--")) throw new CliUsageError(`Usage: ${IMPORT_USAGE}`);
  const { filters, confirmed } = parseProfileOptions(values.slice(1), true);
  const content = await readFile(file, "utf8");
  let input: unknown;
  try { input = JSON.parse(content); }
  catch (error) { throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
  const plan = await buildProfileImport(input, operations, apps, filters, environment.packageOperations);
  for (const line of plan.preview) output(line);
  if (!confirmed) { output("Import not confirmed; rerun with --yes. Nothing was written."); return 0; }
  const results = await applyProfileImport(plan, operations, apps, confirmed, output, environment);
  for (const result of results) output(`${result.status}: ${result.item.label}${result.detail ? `; ${result.detail}` : ""}`);
  return results.some(result => result.status === "failed") ? 1 : 0;
}
