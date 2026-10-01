import { createAppOperations, type AppEnvironment } from "./app-flow.js";

export interface AppOwnedSkillOptions {
  readonly homeDirectory?: string;
  readonly appEnvironment?: AppEnvironment;
  readonly reportWarning?: (warning: string) => void;
}

/** Declarative ownership only: never runs a recipe command or inspects a Skill path. */
export async function loadAppOwnedSkillFilter(options: AppOwnedSkillOptions): Promise<(name: string) => boolean> {
  const warn = options.reportWarning ?? (warning => process.emitWarning(warning));
  try {
    const entries = await createAppOperations({ homeDirectory: options.homeDirectory, ...options.appEnvironment }).load();
    const invalid = entries.filter(entry => entry.error);
    if (invalid.length) throw new Error(invalid.map(entry => `${entry.file}: ${entry.error}`).join("; "));
    const patterns = entries.filter(entry => entry.applicable).flatMap(entry => entry.recipe?.skills ?? []);
    const matchers = patterns.map(pattern => {
      // Only * is special; all other characters are literal. Separators are forbidden.
      if (/[\\/]/u.test(pattern) || pattern.includes("\u0000")) throw new Error(`Invalid owned-skill pattern ${JSON.stringify(pattern)}: path separators are not allowed`);
      return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/\\\\]*")}$`, "u");
    });
    return name => matchers.some(matcher => matcher.test(name));
  } catch (error) {
    warn(`WARNING: App-owned Skill exclusions unavailable; no exclusions applied: ${error instanceof Error ? error.message : String(error)}`);
    return () => false;
  }
}

export async function assertSkillNotAppOwned(name: string, options: AppOwnedSkillOptions): Promise<void> {
  if ((await loadAppOwnedSkillFilter(options))(name)) {
    throw new Error(`App-owned Skill ${JSON.stringify(name)} cannot be adopted or removed through unmanaged flows; no path was changed`);
  }
}
