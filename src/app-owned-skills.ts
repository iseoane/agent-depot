import { createAppOperations, type AppEnvironment } from "./app-flow.js";
import { APP_SKILL_PATTERN } from "./app-recipes.js";

export interface AppOwnedSkillOptions {
  readonly homeDirectory?: string;
  readonly appEnvironment?: AppEnvironment;
  readonly reportWarning?: (warning: string) => void;
}

/**
 * Loads declarative ownership without running commands or inspecting Skill paths.
 * Invalid recipes/patterns warn and are skipped; a directory load failure yields no exclusions.
 */
export async function loadAppOwnedSkillFilter(options: AppOwnedSkillOptions): Promise<(name: string) => boolean> {
  const warn = options.reportWarning ?? (warning => process.emitWarning(warning));
  try {
    const entries = await createAppOperations({
      homeDirectory: options.homeDirectory, ...options.appEnvironment,
    }).load();
    const matchers: RegExp[] = [];
    for (const entry of entries) {
      if (entry.error) {
        warn(`WARNING: Skipping App-owned Skill exclusions for ${entry.file}: ${entry.error}`);
        continue;
      }
      if (!entry.applicable) continue;
      for (const pattern of entry.recipe?.skills ?? []) {
        // Only * is special; all other characters are literal. Separators are forbidden.
        if (!new RegExp(APP_SKILL_PATTERN, "u").test(pattern)) {
          warn(`WARNING: Skipping owned-skill pattern ${JSON.stringify(pattern)} in ${entry.file}: invalid name pattern`);
          continue;
        }
        matchers.push(new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/\\\\]*")}$`, "u"));
      }
    }
    return name => matchers.some(matcher => matcher.test(name));
  } catch (error) {
    warn(`WARNING: App-owned Skill exclusions unavailable; no exclusions applied: ${error instanceof Error ? error.message : String(error)}`);
    return () => false;
  }
}

/** Reloads declarations and refuses unmanaged adoption/removal of an App-owned name. */
export async function assertSkillNotAppOwned(name: string, options: AppOwnedSkillOptions): Promise<void> {
  if ((await loadAppOwnedSkillFilter(options))(name)) {
    throw new Error(`App-owned Skill ${JSON.stringify(name)} cannot be adopted or removed through unmanaged flows; no path was changed`);
  }
}
