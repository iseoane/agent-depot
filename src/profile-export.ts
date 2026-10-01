import path from "node:path";
import type { AppOperations } from "./app-flow.js";
import { loadAppOwnedSkillFilter } from "./app-owned-skills.js";
import { sourceIdForUrl } from "./git-source.js";
import { AGENT_DEPOT_PACKAGE_VERSION } from "./project-manifest.js";
import { parseProfile, PROFILE_FORMAT, type Profile } from "./profile.js";
import type { SourceOperations } from "./sources.js";
import { scanUserGlobalSkillInventory } from "./user-global-skill-inventory.js";

export interface ProfileFilters {
  readonly noSources?: boolean;
  readonly noSkills?: boolean;
  readonly noApps?: boolean;
  readonly sources?: readonly string[];
  readonly skills?: readonly string[];
  readonly apps?: readonly string[];
}
export interface ProfileExportOptions extends ProfileFilters {
  /** Discovery choices are transient; absent means all registered Sources, as in Catalog. */
  readonly includedSourceIds?: readonly string[];
  readonly homeDirectory?: string;
}

export function selectProfileItems<T>(items: readonly T[], requested: readonly string[] | undefined, disabled: boolean | undefined,
  names: (item: T) => readonly string[], block: string): readonly T[] {
  if (disabled && requested?.length) throw new Error(`${block}: filters cannot be combined with --no-${block}`);
  for (const name of requested ?? []) {
    if (!items.some(item => names(item).includes(name))) throw new Error(`${block}: unknown selection ${JSON.stringify(name)}`);
  }
  return disabled ? [] : items.filter(item => !requested?.length || names(item).some(name => requested.includes(name)));
}

function validateOne<Block extends "sources" | "skills" | "apps">(block: Block, item: unknown): Profile[Block][number] {
  const profile = parseProfile({ format: PROFILE_FORMAT, agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
    sources: [], skills: [], apps: [], [block]: [item] });
  return profile[block][0]!;
}

/** Read-only export plan shared by terminal frontends; never refreshes Sources or executes recipes. */
export async function buildProfileExport(operations: SourceOperations, apps: AppOperations,
  options: ProfileExportOptions = {}): Promise<{ readonly profile: Profile; readonly preview: readonly string[] }> {
  if (!operations.listUserGlobalInstallations) throw new Error("Profile export requires user-global installation listing");
  if (!AGENT_DEPOT_PACKAGE_VERSION) throw new Error("Unable to determine the Agent Depot package version");
  const preview: string[] = [];
  const sources = selectProfileItems(await operations.listSources(), options.sources, options.noSources,
    source => source.kind === "git" ? [source.id, source.url] : [source.id], "sources");
  const allInstallations = await operations.listUserGlobalInstallations();
  const installations = selectProfileItems(allInstallations, options.skills, options.noSkills,
    skill => [skill.path, path.posix.basename(skill.path)], "skills");
  const entries = selectProfileItems(await apps.load(), options.apps, options.noApps,
    entry => [entry.recipe?.name ?? path.basename(entry.file)], "apps");
  const owned = await loadAppOwnedSkillFilter({ appEnvironment: { recipesDirectory: apps.directory },
    reportWarning: warning => preview.push(warning) });
  const portableSources: Profile["sources"][number][] = [];
  for (const source of sources) {
    if (source.kind === "builtin") {
      preview.push("Excluded built-in Source: always present (built-in Skill selections remain portable)");
      continue;
    }
    try {
      portableSources.push(validateOne("sources", {
        url: source.url, included: options.includedSourceIds?.includes(source.id) ?? true,
      }));
    } catch (error) {
      preview.push(`Excluded Source ${source.id}: local-path or invalid Source, not portable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const skills: Profile["skills"][number][] = [];
  for (const skill of installations) {
    if (owned(path.posix.basename(skill.installation?.path ?? skill.path))) {
      preview.push(`Excluded Skill ${skill.path}: App-owned`);
      continue;
    }
    const { source, path: skillPath, version, hosts, methods } = skill;
    const selection = { source, path: skillPath, version, hosts, ...(methods ? { methods } : {}) };
    try {
      skills.push(validateOne("skills", selection));
      if (skill.installation) preview.push(`Excluded installation location and version evidence for Skill ${skill.path}: machine-specific`);
    } catch (error) {
      preview.push(`Excluded Skill ${skill.path}: not portable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const recipes: Profile["apps"][number][] = [];
  for (const entry of entries) {
    try {
      if (entry.error) throw new Error(entry.error);
      recipes.push(validateOne("apps", entry.recipe));
    } catch (error) {
      preview.push(`Excluded App recipe ${path.basename(entry.file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!options.noSkills) {
    const inventory = await scanUserGlobalSkillInventory({
      homeDirectory: options.homeDirectory, managedInstallations: allInstallations,
      appEnvironment: { recipesDirectory: apps.directory }, reportWarning: warning => preview.push(warning),
    });
    for (const name of new Set([...inventory.unmanaged, ...inventory.symlinks].map(skill => skill.name))) {
      preview.push(`Excluded unmanaged Skill ${name}: not tracked`);
    }
  }
  for (const skill of skills) {
    const identity = skill.source;
    if (identity.kind === "external" && "url" in identity &&
      !portableSources.some(source => source.url === identity.url)) {
      preview.push(`WARNING: Skill ${skill.path} references Source ${identity.url} not included in profile`);
    }
  }
  const profile = parseProfile({ format: PROFILE_FORMAT, agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
    sources: portableSources, skills, apps: recipes });
  preview.unshift("Preview: export portable user-global profile",
    ...profile.sources.map(source => `Source ${sourceIdForUrl(source.url)} ${source.url} (included: ${source.included})`),
    ...profile.skills.map(skill => `Skill ${skill.path} [${skill.hosts.join(", ")}] (${skill.version.policy})`),
    ...profile.apps.map(recipe => `App recipe ${recipe.name} (${recipe.platform ?? "all platforms"}; no approval)`));
  return { profile, preview };
}
