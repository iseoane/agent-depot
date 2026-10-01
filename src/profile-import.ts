import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AppOperations } from "./app-flow.js";
import { compareAppVersions } from "./app-version.js";
import { canonicalizeGitSourceUrl, sourceIdForUrl } from "./git-source.js";
import { selectProfileItems, type ProfileFilters } from "./profile-export.js";
import { parseProfile, PROFILE_FORMAT, type Profile } from "./profile.js";
import { AGENT_DEPOT_PACKAGE_VERSION, type ProjectSkillSelection } from "./project-manifest.js";
import { defaultProjectSkillTreeAccess, executeSingleInstall, formatVersionPolicy, outputSingleInstallPreview, planSingleInstall,
  type InstallEnvironment } from "./skill-install.js";
import { resolveProjectSource, type Source, type SourceOperations } from "./sources.js";

export type ProfileImportItem = (
  { readonly block: "sources"; readonly value: Profile["sources"][number] } |
  { readonly block: "skills"; readonly value: Profile["skills"][number] } |
  { readonly block: "apps"; readonly value: Profile["apps"][number] }
) & { readonly status: "add" | "same" | "conflict"; readonly label: string; readonly difference?: string };
export interface ProfileImportPlan {
  readonly items: readonly ProfileImportItem[];
  readonly preview: readonly string[];
}

// Compare declarations, not installation evidence or JSON object insertion order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function skillIdentity(skill: ProjectSkillSelection): string {
  const source = skill.source;
  return canonical([source.kind === "external" && "url" in source
    ? { ...source, url: canonicalizeGitSourceUrl(source.url) } : source, skill.path]);
}
function skillChoices(skill: ProjectSkillSelection) {
  return { hosts: [...skill.hosts].sort(), version: skill.version, methods: skill.methods };
}
function recipeIdentity(recipe: Profile["apps"][number]): string {
  return canonical([recipe.name, recipe.platform]);
}
function fieldDifferences(existing: object, incoming: object): string[] {
  const left = new Map(Object.entries(existing)), right = new Map(Object.entries(incoming));
  return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(key =>
    canonical(left.get(key)) === canonical(right.get(key)) ? []
      : [`${key}: existing ${canonical(left.get(key))} -> incoming ${canonical(right.get(key))}`]);
}
function comparison(existing: object | undefined, incoming: object) {
  if (existing === undefined) return { status: "add" as const };
  const differences = fieldDifferences(existing, incoming);
  return differences.length ? { status: "conflict" as const, difference: differences.join("; ") } : { status: "same" as const };
}

async function loadImportRecipes(apps: AppOperations) {
  const entries = await apps.load();
  return Promise.all(entries.map(async entry => {
    let content: object | undefined = entry.recipe;
    let error = entry.error;
    let name = entry.recipe?.name;
    let platform: unknown = entry.recipe?.platform;
    if (!content) {
      try {
        const raw: unknown = JSON.parse(await readFile(entry.file, "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          content = raw;
          const rawName = (raw as { name?: unknown }).name;
          if (typeof rawName === "string") name = rawName;
          platform = (raw as { platform?: unknown }).platform;
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        error = `${entry.error && entry.error !== reason ? `${entry.error}; ` : ""}raw JSON read/parse failed: ${reason}`;
      }
    }
    return { file: entry.file, name, platform, content, error };
  }));
}

function classifySource(value: Profile["sources"][number], sources: readonly Source[]): ProfileImportItem {
  const exists = sources.some(source => source.kind === "git" && canonicalizeGitSourceUrl(source.url) === value.url);
  return { block: "sources", value, label: `Source ${value.url} (included: ${value.included})`, status: exists ? "same" : "add",
    ...(exists && !value.included ? { difference: "included: existing true -> incoming false (discovery inclusion is not imported)" } : {}) };
}
function classifySkill(value: Profile["skills"][number], skills: readonly ProjectSkillSelection[]): ProfileImportItem {
  const existing = skills.find(skill => skillIdentity(skill) === skillIdentity(value));
  return { block: "skills", value, label: `Skill ${value.path}`, ...comparison(existing && skillChoices(existing), skillChoices(value)) };
}
function classifyRecipe(value: Profile["apps"][number], recipes: Awaited<ReturnType<typeof loadImportRecipes>>): ProfileImportItem {
  const existing = recipes.filter(entry => entry.name === value.name &&
    (entry.platform === undefined || value.platform === undefined || entry.platform === value.platform));
  return { block: "apps", value, label: `App recipe ${value.name} (${value.platform ?? "all platforms"}; unapproved; Apps are not installed)`,
    status: existing.length ? "conflict" : "add",
    ...(existing.length ? { difference: existing.map(entry => `${entry.file}: name ${JSON.stringify(value.name)} already present with overlapping platforms; ${
      fieldDifferences(entry.content ?? {}, value).join("; ") || "content identical"}`).join("; ") } : {}) };
}

/** Load only this block; retained across skips and invalidated after every attempted write. */
async function loadImportClassifier(block: ProfileImportItem["block"], operations: SourceOperations, apps: AppOperations) {
  if (block === "sources") {
    const sources = await operations.listSources();
    return (item: ProfileImportItem) => item.block === "sources" ? classifySource(item.value, sources) : item;
  }
  if (block === "skills") {
    if (!operations.listUserGlobalInstallations) throw new Error("Profile import requires user-global installation listing");
    const skills = await operations.listUserGlobalInstallations();
    return (item: ProfileImportItem) => item.block === "skills" ? classifySkill(item.value, skills) : item;
  }
  const recipes = await loadImportRecipes(apps);
  return (item: ProfileImportItem) => item.block === "apps" ? classifyRecipe(item.value, recipes) : item;
}

/** Read-only classification. Inclusion is a transient frontend choice, not persisted Source state. */
export async function buildProfileImport(input: unknown, operations: SourceOperations, apps: AppOperations,
  filters: ProfileFilters = {}): Promise<ProfileImportPlan> {
  const profile = parseProfile(input);
  if (!operations.listUserGlobalInstallations) throw new Error("Profile import requires user-global installation listing");
  const sources = await operations.listSources();
  const skills = await operations.listUserGlobalInstallations();
  const recipes = await loadImportRecipes(apps);
  const items: ProfileImportItem[] = [];
  for (const value of selectProfileItems(profile.sources, filters.sources, filters.noSources,
    source => [source.url, sourceIdForUrl(source.url)], "sources")) items.push(classifySource(value, sources));
  for (const value of selectProfileItems(profile.skills, filters.skills, filters.noSkills,
    skill => [skill.path, path.posix.basename(skill.path)], "skills")) items.push(classifySkill(value, skills));
  for (const value of selectProfileItems(profile.apps, filters.apps, filters.noApps, recipe => [recipe.name], "apps")) {
    items.push(classifyRecipe(value, recipes));
  }
  const preview = ["Preview: import portable user-global profile", ...items.flatMap(item => {
    const status = item.block === "sources" && item.status === "same" && !item.value.included
      ? "same (discovery inclusion is not imported)" : item.status;
    const lines = [`${status}: ${item.label}${item.difference ? `; ${item.difference}` : ""}`];
    if (item.block === "skills" && item.status === "add") {
      const skill = item.value;
      lines.push(`  Source ${canonical(skill.source)}`,
        `  hosts: ${skill.hosts.join(",")}; version policy: ${formatVersionPolicy(skill.version)}`);
      for (const [action, method] of Object.entries(skill.methods ?? {})) {
        lines.push(`  ${action}: argv=${JSON.stringify(method.argv)} (user-provided method from the profile, runs only after --yes)`);
      }
      const source = skill.source;
      if (source.kind === "external" && "url" in source &&
        !sources.some(registered => registered.kind === "git" && canonicalizeGitSourceUrl(registered.url) === canonicalizeGitSourceUrl(source.url)) &&
        !items.some(candidate => candidate.block === "sources" && canonicalizeGitSourceUrl(candidate.value.url) === canonicalizeGitSourceUrl(source.url) && candidate.status === "add")) {
        lines.push(`  Source ${source.url} will be fetched but not registered`);
      }
    }
    return lines;
  })];
  preview.push(...recipes.filter(entry => entry.error).map(entry => `WARNING: ${entry.file}: ${entry.error}${entry.name === undefined ? "; name unknown; unrelated names are not blocked" : ""}`));
  if (AGENT_DEPOT_PACKAGE_VERSION && (compareAppVersions(profile.agentDepotVersion, AGENT_DEPOT_PACKAGE_VERSION) ?? 0) > 0) {
    preview.push(`WARNING: profile Agent Depot ${profile.agentDepotVersion} is newer than running ${AGENT_DEPOT_PACKAGE_VERSION}`);
  }
  preview.push("Existing choices are never replaced. Source inclusion is a transient discovery choice.",
    "Same-name App recipes conflict only when platforms overlap; disjoint platform recipes can both be added.");
  return { items, preview };
}

export interface ProfileImportEnvironment extends InstallEnvironment {
  readonly homeDirectory?: string;
}
export interface ProfileImportResult {
  readonly item: ProfileImportItem;
  readonly status: "added" | "skipped" | "failed";
  readonly detail?: string;
}

/** Publish complete JSON exclusively: rename would silently overwrite an existing recipe. */
async function writeRecipe(directory: string, recipe: Profile["apps"][number]): Promise<void> {
  await mkdir(directory, { recursive: true });
  // A new canonical path cannot inherit a receipt left by a deleted recipe.
  const filename = `profile-${createHash("sha256").update(recipeIdentity(recipe)).digest("hex")}-${randomUUID()}.json`;
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx" });
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Apply only confirmed additions, rechecking destination choices per item. Failures remain independent. */
export async function applyProfileImport(plan: ProfileImportPlan, operations: SourceOperations, apps: AppOperations,
  confirmed: boolean, output: (line: string) => void, environment: ProfileImportEnvironment = {}): Promise<readonly ProfileImportResult[]> {
  const results: ProfileImportResult[] = [];
  for (const block of ["sources", "skills", "apps"] as const) {
    let classify: Awaited<ReturnType<typeof loadImportClassifier>> | undefined;
    for (const item of plan.items.filter(item => item.block === block)) {
      if (!confirmed || item.status !== "add") { results.push({ item, status: "skipped" }); continue; }
      try {
        parseProfile({ format: PROFILE_FORMAT, agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
          sources: [], skills: [], apps: [], [block]: [item.value] });
        classify ??= await loadImportClassifier(block, operations, apps);
        const recheck = classify(item);
        if (recheck.status !== "add") {
          results.push({ item, status: "skipped", detail: `${recheck.status}: ${recheck.label}${recheck.difference ? `; ${recheck.difference}` : ""}` }); continue;
        }
        // Even a failing install method can persist state or change recipe files.
        classify = undefined;
        if (item.block === "sources") await operations.addGitSource(item.value.url);
        else if (item.block === "apps") await writeRecipe(apps.directory, item.value);
        else {
          await installImportedSkill(item.value, operations, apps, output, environment);
        }
        results.push({ item, status: "added" });
      } catch (error) {
        results.push({ item, status: "failed", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

async function installImportedSkill(selection: Profile["skills"][number], operations: SourceOperations, apps: AppOperations,
  output: (line: string) => void, environment: ProfileImportEnvironment): Promise<void> {
  if (!operations.addUserGlobalInstallation || !operations.listUserGlobalInstallations) throw new Error("Cannot persist user-global Skills");
  const source = selection.source;
  // A Skill's Source identity is self-contained even when its Source block was filtered out.
  const resolvedSource = await (operations.resolveProjectSource ? operations.resolveProjectSource(source) : resolveProjectSource(source));
  const install = await planSingleInstall({ scope: "user-global", sourceId: resolvedSource.id, skillPath: selection.path,
    version: selection.version, hosts: selection.hosts, ref: source.kind === "external" ? source.ref : undefined,
    method: selection.methods?.install, portableV1: true, confirmed: true, overwrite: false, confirmAdditionalHostExposure: false },
  { operations: { ...operations, listSources: async () => [resolvedSource] }, sourceAccess: operations.readSkillTreeSnapshot ? {
    readSkillTree: async (source, skillPath) => (await operations.readSkillTreeSnapshot!(source, skillPath)).files,
    readSkillTreeSnapshot: (source, skillPath) => operations.readSkillTreeSnapshot!(source, skillPath),
  } : defaultProjectSkillTreeAccess(),
    environment: { ...environment, appEnvironment: { recipesDirectory: apps.directory } }, root: path.resolve(environment.homeDirectory ?? homedir()),
    existing: await operations.listUserGlobalInstallations(), recordedIn: "user-global state" });
  // Preserve both user methods and the exact recorded Source ref/version choices.
  const exactPlan = { ...install, selection, resolved: { ...install.resolved, selection } };
  outputSingleInstallPreview(exactPlan, output);
  await executeSingleInstall(exactPlan, record => operations.addUserGlobalInstallation!(record), output);
}
