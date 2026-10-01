import { writeFile } from "node:fs/promises";
import type { AppOperations } from "./app-flow.js";
import { buildProfileExport, type ProfileFilters } from "./profile-export.js";
import { serializeProfile } from "./profile.js";
import type { SourceOperations } from "./sources.js";
import { CliUsageError } from "./usage-error.js";

export const EXPORT_USAGE = "agent-depot export [--out <file>] [--no-sources] [--no-skills] [--no-apps] [--source <id|url>...] [--skill <path|name>...] [--app <name>...]";

export async function runProfileExport(values: readonly string[], operations: SourceOperations, apps: AppOperations,
  output: (line: string) => void, diagnostic: (line: string) => void): Promise<number> {
  const sources: string[] = [], skills: string[] = [], appNames: string[] = [];
  const filters: { -readonly [Key in keyof ProfileFilters]: ProfileFilters[Key] } = { sources, skills, apps: appNames };
  let out: string | undefined;
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === "--no-sources") filters.noSources = true;
    else if (option === "--no-skills") filters.noSkills = true;
    else if (option === "--no-apps") filters.noApps = true;
    else if (["--out", "--source", "--skill", "--app"].includes(option!)) {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw new CliUsageError(`${option} requires a value`);
      if (option === "--out") {
        if (out !== undefined) throw new CliUsageError("Duplicate --out");
        out = value;
      } else {
        const names = option === "--source" ? sources : option === "--skill" ? skills : appNames;
        if (names.includes(value)) throw new CliUsageError(`Duplicate ${option} ${JSON.stringify(value)}`);
        names.push(value);
      }
    } else throw new CliUsageError(`Usage: ${EXPORT_USAGE}`);
  }
  const plan = await buildProfileExport(operations, apps, filters);
  for (const line of plan.preview) diagnostic(line);
  const content = serializeProfile(plan.profile);
  if (out === undefined) output(content.trimEnd());
  else {
    // An export is a new artifact, not permission to replace an existing file or follow a symlink.
    await writeFile(out, content, { encoding: "utf8", flag: "wx" });
    diagnostic(`Exported profile to ${out}`);
  }
  return 0;
}
