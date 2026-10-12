import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppOperations } from "./app-flow.js";
import { loadAppOwnedSkillFilter } from "./app-owned-skills.js";
import { sourceIdForUrl } from "./git-source.js";
import { bundleRoot, describeCoordinates, type PackageSelection } from "./package-model.js";
import { AGENT_DEPOT_PACKAGE_VERSION } from "./project-manifest.js";
import { parseProfile, PROFILE_FORMAT, PROFILE_FORMAT_V2, serializeProfile, type Profile, type ProfilePackageOperations, type ProfileReplica } from "./profile.js";
import { formatVersionPolicy } from "./skill-install.js";
import type { SourceOperations } from "./sources.js";
import { scanUserGlobalSkillInventory } from "./user-global-skill-inventory.js";

export interface ProfileFilters {
  readonly noSources?: boolean;
  readonly noSkills?: boolean;
  readonly noApps?: boolean;
  readonly noPackages?: boolean;
  readonly sources?: readonly string[];
  readonly skills?: readonly string[];
  readonly apps?: readonly string[];
  readonly packages?: readonly string[];
}
export interface ProfileExportOptions extends ProfileFilters {
  /** Discovery choices are transient; absent means all registered Sources, as in Catalog. */
  readonly includedSourceIds?: readonly string[];
  readonly homeDirectory?: string;
  /** Records whose selections are exported. Absent writes no Package block entries. */
  readonly packageOperations?: ProfilePackageOperations;
}

export interface ProfileExportExclusion {
  readonly block: "sources" | "skills" | "apps" | "packages" | "replicas";
  readonly label: string;
  readonly reason: string;
}
export interface ProfileExportWarning {
  readonly kind: "load" | "source";
  readonly message: string;
}
export type ProfileExportDiagnostic = ProfileExportExclusion | ProfileExportWarning;
export interface ProfileExportPlan {
  readonly profile: Profile;
  readonly exclusions: readonly ProfileExportExclusion[];
  readonly warnings: readonly ProfileExportWarning[];
  readonly preview: readonly string[];
}

export const SKILL_EXPORT_EXPLANATION = "Selected Skills are exported with their version policy; destination install paths and Host links are recreated. Local paths and symlink targets do not travel.";

export function selectProfileItems<T>(items: readonly T[], requested: readonly string[] | undefined, disabled: boolean | undefined,
  names: (item: T) => readonly string[], block: string): readonly T[] {
  if (disabled && requested?.length) throw new Error(`${block}: filters cannot be combined with --no-${block}`);
  for (const name of requested ?? []) {
    if (!items.some(item => names(item).includes(name))) throw new Error(`${block}: unknown selection ${JSON.stringify(name)}`);
  }
  return disabled ? [] : items.filter(item => !requested?.length || names(item).some(name => requested.includes(name)));
}

/** The Package identities a `--package` filter accepts, matching `describeCoordinates`. */
export function packageFilterNames(selection: PackageSelection): readonly string[] {
  const root = bundleRoot(selection);
  const names: string[] = [describeCoordinates(selection)];
  if (root !== "") {
    names.push(root);
    const basename = path.posix.basename(root);
    if (basename !== root) names.push(basename);
  }
  if (selection.host === "claude") names.push(selection.pluginName);
  return names;
}

/** One Package line, shared by the export preview and the import plan label. */
export function describeProfilePackage(selection: PackageSelection): string {
  return `Package ${describeCoordinates(selection)} from ${profileSourceIdentity(selection.source)} (${formatVersionPolicy(selection.version)}; saved selection)`;
}

export function describeProfileSkill(skill: Profile["skills"][number]): string {
  return `Skill ${skill.path} from ${profileSourceIdentity(skill.source)} (${skill.version.policy})`;
}

export function describeProfileReplica(replica: ProfileReplica): string {
  switch (replica.kind) {
    case "skill": return `Installed Skill ${replica.path} from ${profileSourceIdentity(replica.source)}`;
    case "app": return `Installed App ${replica.name} (${replica.platform ?? "all platforms"})`;
    case "package": return `Installed Package ${describeCoordinates(replica.selection)} from ${profileSourceIdentity(replica.selection.source)}`;
  }
}

function profileSourceIdentity(source: Profile["skills"][number]["source"]): string {
  if (source.kind === "builtin") return "Agent Depot (built-in Source)";
  if ("url" in source) return source.url;
  return source.path;
}

function validateOne<Block extends "sources" | "skills" | "apps" | "packages">(block: Block, item: unknown): Profile[Block][number] {
  const profile = parseProfile({ format: PROFILE_FORMAT, agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
    sources: [], skills: [], apps: [], [block]: [item] });
  return profile[block][0]!;
}

/** Read-only export plan shared by terminal frontends; never refreshes Sources or executes recipes. */
export async function buildProfileExport(operations: SourceOperations, apps: AppOperations,
  options: ProfileExportOptions = {}): Promise<ProfileExportPlan> {
  if (!operations.listUserGlobalInstallations) throw new Error("Profile export requires user-global installation listing");
  if (!AGENT_DEPOT_PACKAGE_VERSION) throw new Error("Unable to determine the Agent Depot package version");
  const diagnostics: ProfileExportDiagnostic[] = [];
  const exclude = (block: ProfileExportExclusion["block"], label: string, reason: string) => {
    diagnostics.push({ block, label, reason });
  };
  const warn = (message: string) => diagnostics.push({ kind: "load", message });
  const sources = selectProfileItems(await operations.listSources(), options.sources, options.noSources,
    source => source.kind === "git" ? [source.id, source.url] : [source.id], "sources");
  const allInstallations = await operations.listUserGlobalInstallations();
  const installations = selectProfileItems(allInstallations, options.skills, options.noSkills,
    skill => [skill.path, path.posix.basename(skill.path)], "skills");
  const entries = selectProfileItems(await apps.load(), options.apps, options.noApps,
    entry => [entry.recipe?.name ?? path.basename(entry.file)], "apps");
  const packageRecords = options.packageOperations === undefined ? [] : await options.packageOperations.list();
  if (options.packageOperations === undefined && options.packages?.length) {
    throw new Error("Profile export requires Package operations to select Packages");
  }
  const selectedPackages = selectProfileItems(packageRecords, options.packages, options.noPackages,
    record => packageFilterNames(record.selection), "packages");
  const owned = await loadAppOwnedSkillFilter({ appEnvironment: { recipesDirectory: apps.directory },
    reportWarning: warn });
  const portableSources: Profile["sources"][number][] = [];
  for (const source of sources) {
    if (source.kind === "builtin") {
      exclude("sources", "built-in Source", "always present (built-in Skill selections remain portable)");
      continue;
    }
    try {
      portableSources.push(validateOne("sources", {
        url: source.url, included: options.includedSourceIds?.includes(source.id) ?? true,
      }));
    } catch (error) {
      exclude("sources", `Source ${source.id}`, `local-path or invalid Source, not portable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const skills: Profile["skills"][number][] = [];
  const replicas: ProfileReplica[] = [];
  for (const skill of installations) {
    if (owned(path.posix.basename(skill.installation?.path ?? skill.path))) {
      exclude("skills", `Skill ${skill.path}`, "App-owned");
      continue;
    }
    const { source, path: skillPath, version, hosts, methods } = skill;
    const selection = { source, path: skillPath, version, hosts, ...(methods ? { methods } : {}) };
    try {
      skills.push(validateOne("skills", selection));
      replicas.push({ kind: "skill", source: skill.source, path: skill.path });
    } catch (error) {
      exclude("skills", `Skill ${skill.path}`, `not portable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const recipes: Profile["apps"][number][] = [];
  let appInstallations: Awaited<ReturnType<AppOperations["trackedApps"]>> = [];
  try { appInstallations = await apps.trackedApps(warn); }
  catch (error) { warn(`App installation records could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  for (const entry of entries) {
    try {
      if (entry.error) throw new Error(entry.error);
      recipes.push(validateOne("apps", entry.recipe));
      const tracked = entry.recipe && entry.canonicalFile && appInstallations.find(record =>
        record.name === entry.recipe!.name && path.resolve(record.recipeFile) === path.resolve(entry.canonicalFile!));
      let inspection: Awaited<ReturnType<AppOperations["inspectForExport"]>>;
      try {
        inspection = await apps.inspectForExport(entry);
      } catch (error) {
        exclude("replicas", `App ${entry.recipe!.name} (${entry.recipe!.platform ?? "all platforms"})`,
          `current installation state could not be read, so it is not marked for replication (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (inspection.status === "installed" && entry.recipe) {
        replicas.push({ kind: "app", name: entry.recipe.name,
          ...(entry.recipe.platform === undefined ? {} : { platform: entry.recipe.platform }) });
      } else if (tracked && inspection.status !== "not installed") {
        exclude("replicas", `App ${entry.recipe!.name} (${entry.recipe!.platform ?? "all platforms"})`,
          `a tracked install record exists, but current installation state is ${inspection.status}${inspection.reason ? ` (${inspection.reason})` : ""}; not marked for replication`);
      } else if (tracked && inspection.status === "not installed") {
        exclude("replicas", `App ${entry.recipe!.name} (${entry.recipe!.platform ?? "all platforms"})`,
          "the current version probe reports not installed; stale tracking does not create replica intent");
      }
    } catch (error) {
      exclude("apps", `App recipe ${path.basename(entry.file)}`, error instanceof Error ? error.message : String(error));
    }
  }
  const packages: Profile["packages"][number][] = [];
  for (const record of selectedPackages) {
    try {
      packages.push(validateOne("packages", record.selection));
      try {
        const inspection = await options.packageOperations?.inspect(record.selection);
        if (inspection?.installed.kind === "installed") replicas.push({ kind: "package", selection: record.selection });
        else if (inspection?.installed.kind === "unknown") {
          exclude("replicas", describeProfilePackage(record.selection),
            `host installation state is unknown, so it is not marked for replication (${inspection.installed.reason})`);
        }
      } catch (error) {
        exclude("replicas", describeProfilePackage(record.selection),
          `host installation state could not be read, so it is not marked for replication (${error instanceof Error ? error.message : String(error)})`);
      }
    } catch (error) {
      exclude("packages", describeProfilePackage(record.selection),
        `not portable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!options.noSkills) {
    const inventory = await scanUserGlobalSkillInventory({
      homeDirectory: options.homeDirectory, managedInstallations: allInstallations,
      appEnvironment: { recipesDirectory: apps.directory }, reportWarning: warn,
    });
    for (const name of new Set([...inventory.unmanaged, ...inventory.symlinks].map(skill => skill.name))) {
      exclude("skills", `unmanaged Skill ${name}`, "not tracked");
    }
  }
  const profile = parseProfile({ format: replicas.length ? PROFILE_FORMAT_V2 : PROFILE_FORMAT, agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
    sources: portableSources, skills, apps: recipes, packages, ...(replicas.length ? { replicas } : {}) });
  return {
    profile,
    exclusions: diagnostics.filter((item): item is ProfileExportExclusion => "block" in item),
    warnings: [...diagnostics.filter((item): item is ProfileExportWarning => "kind" in item), ...sourceWarnings(profile)],
    preview: profileExportPreview(profile, diagnostics),
  };
}

function sourceWarnings(profile: Profile): readonly ProfileExportWarning[] {
  const missing = (source: Profile["skills"][number]["source"], label: string): readonly ProfileExportWarning[] =>
    source.kind === "external" && "url" in source && !profile.sources.some(candidate => candidate.url === source.url)
      ? [{ kind: "source" as const, message: `WARNING: ${label} references Source ${source.url} not included in profile` }]
      : [];
  return [
    ...profile.skills.flatMap(skill => missing(skill.source, `Skill ${skill.path}`)),
    ...profile.packages.flatMap(selection => missing(selection.source, describeProfilePackage(selection))),
  ];
}

/** Describes whether an export diagnostic removes a selection or only omits machine-local metadata. */
export function describeProfileExportExclusion(item: ProfileExportExclusion): string {
  if (item.reason.startsWith("always present")) return `Not transferred because it is always present: ${item.label}`;
  return `Excluded ${item.label}: ${item.reason}`;
}

/** Shared preview for a frontend-selected subset; Source warnings are recomputed. */
export function profileExportPreview(profile: Profile, diagnostics: readonly ProfileExportDiagnostic[] = []): readonly string[] {
  return ["Preview: export portable user-global profile",
    SKILL_EXPORT_EXPLANATION,
    ...profile.sources.map(source => `Source ${sourceIdForUrl(source.url)} ${source.url} (included: ${source.included})`),
    ...profile.skills.map(skill => `Skill ${skill.path} [${skill.hosts.join(", ")}] (${skill.version.policy})`),
    ...profile.apps.map(recipe => `App recipe ${recipe.name} (${recipe.platform ?? "all platforms"}; approval not transferred)`),
    ...profile.packages.map(selection => `${describeProfilePackage(selection)}; no receipt or installed evidence`),
    ...profile.replicas.map(replica => `Replica intent ${describeProfileReplica(replica)}; no installed state or approval is transferred`),
    ...diagnostics.flatMap(item => "block" in item ? [describeProfileExportExclusion(item)] : item.kind === "load" ? [item.message] : []),
    ...sourceWarnings(profile).map(warning => warning.message)];
}

/** Empty profiles are valid to parse, but are not useful export artifacts. */
export function requireProfileExportSelection(profile: Profile): void {
  if (!profile.sources.length && !profile.skills.length && !profile.apps.length && !profile.packages.length) {
    throw new Error("Nothing selected; nothing written.");
  }
}

/** Exclusively create an export artifact; never replace a file or follow a symlink. */
export async function writeProfileExport(file: string, profile: Profile): Promise<void> {
  requireProfileExportSelection(profile);
  try { await writeFile(file, serializeProfile(profile), { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists; choose another path`);
    throw error;
  }
}
