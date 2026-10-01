import { readFile, writeFile } from "node:fs/promises";
import { applyProfileImport, buildProfileImport, type ProfileImportEnvironment } from "./profile-import.js";
import type { AppOperations } from "./app-flow.js";
import { buildProfileExport, type ProfileFilters } from "./profile-export.js";
import { serializeProfile } from "./profile.js";
import type { SourceOperations } from "./sources.js";
import { CliUsageError } from "./usage-error.js";

export const EXPORT_USAGE = "agent-depot export [--out <file>] [--no-sources] [--no-skills] [--no-apps] [--source <id|url>...] [--skill <path|name>...] [--app <name>...]";

export const IMPORT_USAGE = "agent-depot import <file> [--yes] [--no-sources] [--no-skills] [--no-apps] [--source <id|url>...] [--skill <path|name>...] [--app <name>...]";

export async function runProfileExport(values: readonly string[], operations: SourceOperations, apps: AppOperations,
  output: (line: string) => void, diagnostic: (line: string) => void, homeDirectory?: string): Promise<number> {
  const { filters, out } = parseProfileOptions(values, false);
  const plan = await buildProfileExport(operations, apps, { ...filters, homeDirectory });
  for (const line of plan.preview) diagnostic(line);
  const content = serializeProfile(plan.profile);
  if (out === undefined) output(content.trimEnd());
  else {
    // An export is a new artifact, not permission to replace an existing file or follow a symlink.
    try {
      await writeFile(out, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`${out} already exists; choose another path`);
      }
      throw error;
    }
    diagnostic(`Exported profile to ${out}`);
  }
  return 0;
}

function parseProfileOptions(values: readonly string[], importing: boolean) {
  const sources: string[] = [], skills: string[] = [], appNames: string[] = [];
  const filters: { -readonly [Key in keyof ProfileFilters]: ProfileFilters[Key] } = { sources, skills, apps: appNames };
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
    else if (["--out", "--source", "--skill", "--app"].includes(option!)) {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw new CliUsageError(`${option} requires a value`);
      if (option === "--out") {
        if (importing) throw new CliUsageError(`Usage: ${IMPORT_USAGE}`);
        if (out !== undefined) throw new CliUsageError("Duplicate --out");
        out = value;
      } else {
        const names = option === "--source" ? sources : option === "--skill" ? skills : appNames;
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
  const plan = await buildProfileImport(JSON.parse(await readFile(file, "utf8")), operations, apps, filters);
  for (const line of plan.preview) output(line);
  if (!confirmed) { output("Import not confirmed; rerun with --yes. Nothing was written."); return 0; }
  const results = await applyProfileImport(plan, operations, apps, confirmed, output, environment);
  for (const result of results) output(`${result.status}: ${result.item.label}${result.detail ? `; ${result.detail}` : ""}`);
  return results.some(result => result.status === "failed") ? 1 : 0;
}
