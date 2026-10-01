import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AppOperations } from "./app-flow.js";
import { compareAppVersions } from "./app-version.js";
import { canonicalizeGitSourceUrl, sourceIdForUrl } from "./git-source.js";
import { selectProfileItems, type ProfileFilters } from "./profile-export.js";
import { parseProfile, PROFILE_FORMAT, type Profile } from "./profile.js";
import { AGENT_DEPOT_PACKAGE_VERSION, type ProjectSkillSelection } from "./project-manifest.js";
import { defaultProjectSkillTreeAccess, executeSingleInstall, outputSingleInstallPreview, planSingleInstall,
  type InstallEnvironment } from "./skill-install.js";
import { resolveProjectSource, type SourceOperations } from "./sources.js";

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
function comparison(existing: unknown, incoming: unknown) {
  if (existing === undefined) return { status: "add" as const };
  if (canonical(existing) === canonical(incoming)) return { status: "same" as const };
  return { status: "conflict" as const, difference: `existing ${canonical(existing)} -> incoming ${canonical(incoming)}` };
}

/** Read-only classification. Inclusion is a transient frontend choice, not persisted Source state. */
export async function buildProfileImport(input: unknown, operations: SourceOperations, apps: AppOperations,
  filters: ProfileFilters = {}): Promise<ProfileImportPlan> {
  const profile = parseProfile(input);
  if (!operations.listUserGlobalInstallations) throw new Error("Profile import requires user-global installation listing");
  const sources = await operations.listSources();
  const skills = await operations.listUserGlobalInstallations();
  const recipes = await apps.load();
  const items: ProfileImportItem[] = [];
  for (const value of selectProfileItems(profile.sources, filters.sources, filters.noSources,
    source => [source.url, sourceIdForUrl(source.url)], "sources")) {
    const exists = sources.some(source => source.kind === "git" && canonicalizeGitSourceUrl(source.url) === value.url);
    items.push({ block: "sources", value, label: `Source ${value.url} (included: ${value.included})`, status: exists ? "same" : "add" });
  }
  for (const value of selectProfileItems(profile.skills, filters.skills, filters.noSkills,
    skill => [skill.path, path.posix.basename(skill.path)], "skills")) {
    const existing = skills.find(skill => skillIdentity(skill) === skillIdentity(value));
    items.push({ block: "skills", value, label: `Skill ${value.path}`,
      ...comparison(existing && skillChoices(existing), skillChoices(value)) });
  }
  for (const value of selectProfileItems(profile.apps, filters.apps, filters.noApps, recipe => [recipe.name], "apps")) {
    const existing = recipes.filter(entry => entry.recipe && recipeIdentity(entry.recipe) === recipeIdentity(value));
    const existingContent = existing.length > 1 ? existing.map(entry => entry.recipe) : existing[0]?.recipe;
    items.push({ block: "apps", value, label: `App recipe ${value.name} (${value.platform ?? "all platforms"}; unapproved; Apps are not installed)`,
      ...comparison(existingContent, value) });
  }
  const preview = ["Preview: import portable user-global profile", ...items.map(item =>
    `${item.status}: ${item.label}${item.difference ? `; ${item.difference}` : ""}`)];
  if (AGENT_DEPOT_PACKAGE_VERSION && (compareAppVersions(profile.agentDepotVersion, AGENT_DEPOT_PACKAGE_VERSION) ?? 0) > 0) {
    preview.push(`WARNING: profile Agent Depot ${profile.agentDepotVersion} is newer than running ${AGENT_DEPOT_PACKAGE_VERSION}`);
  }
  preview.push("Existing choices are never replaced. Source inclusion is a transient discovery choice.");
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
    await writeFile(temporary, `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx", mode: 0o600 });
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
    for (const item of plan.items.filter(item => item.block === block)) {
      if (!confirmed || item.status !== "add") { results.push({ item, status: "skipped" }); continue; }
      try {
        const recheck = await buildProfileImport({ format: PROFILE_FORMAT, agentDepotVersion: AGENT_DEPOT_PACKAGE_VERSION,
          sources: [], skills: [], apps: [], [block]: [item.value] }, operations, apps);
        if (recheck.items[0]!.status !== "add") {
          results.push({ item, status: "skipped", detail: recheck.preview.join("\n") }); continue;
        }
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
