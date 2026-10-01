import { access, chmod, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { writeFileAtomically } from "./atomic-file.js";
import { parseAppRecipe, type AppRecipe } from "./app-recipes.js";
import { runProcess } from "./process-runner.js";
import { defaultSourceStatePath } from "./source-state.js";

export interface AppEntry {
  readonly file: string;
  readonly canonicalFile?: string;
  readonly hash?: string;
  readonly recipe?: AppRecipe;
  readonly error?: string;
  readonly applicable: boolean;
}

export interface AppInspection {
  readonly status: "invalid" | "not applicable here" | "needs approval" | "installed" | "not installed";
  readonly installedVersion?: string;
  readonly executable?: string;
  readonly reason?: string;
}

export interface AppEnvironment {
  readonly recipesDirectory?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly isWsl?: boolean;
  /** Test seam for simulated Windows drive mounts; defaults to /mnt. */
  readonly wslMountRoot?: string;
  readonly runner?: typeof runProcess;
  readonly resolveExecutable?: (name: string) => Promise<string | undefined>;
}

const WINDOWS_EXECUTABLE_WARNING = "will not run (Windows executable on WSL)";

export function createAppOperations(environment: AppEnvironment = {}) {
  const platform = environment.platform ?? process.platform;
  const home = environment.homeDirectory ?? homedir();
  const stateDirectory = path.dirname(defaultSourceStatePath(process.env, platform, home));
  const directory = environment.recipesDirectory ?? path.join(stateDirectory, "apps");
  const receipts = path.join(path.dirname(directory), "app-approvals");
  const isWsl = environment.isWsl ?? (
    platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
  const mountRoot = environment.wslMountRoot ?? "/mnt";
  const runner = environment.runner ?? runProcess;

  function isWindowsExecutable(executable: string): boolean {
    const relative = path.posix.relative(mountRoot, executable);
    return isWsl && /^[a-z]\//iu.test(relative);
  }

  async function resolve(name: string) {
    if (environment.resolveExecutable) {
      const executable = await environment.resolveExecutable(name);
      const target = executable ? await realpath(executable).catch(() => executable) : undefined;
      return { executable, blocked: target !== undefined && isWindowsExecutable(target) };
    }
    let blockedExecutable: string | undefined;
    const suffixes = platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        try {
          await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
          const target = await realpath(candidate);
          if (isWindowsExecutable(target)) {
            blockedExecutable ??= candidate;
            continue;
          }
          // Preserve shim/multicall identity when spawning; realpath is only a safety check.
          return { executable: candidate, blocked: false };
        } catch {
          // Try the next PATH entry.
        }
      }
    }
    return { executable: blockedExecutable, blocked: blockedExecutable !== undefined };
  }

  const receiptPath = (entry: AppEntry) => path.join(
    receipts, createHash("sha256").update(entry.canonicalFile!).digest("hex") + ".json",
  );

  async function read(file: string): Promise<AppEntry> {
    try {
      const canonicalFile = await realpath(file);
      const content = await readFile(canonicalFile);
      const recipe = parseAppRecipe(JSON.parse(content.toString("utf8")));
      const currentPlatform = platform === "win32" ? "windows" : platform;
      return {
        file, canonicalFile, recipe, hash: createHash("sha256").update(content).digest("hex"),
        applicable: recipe.platform === undefined || recipe.platform === currentPlatform,
      };
    } catch (error) {
      return { file, applicable: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function rejectDuplicates(entries: AppEntry[]): AppEntry[] {
    const names = new Map<string, number>();
    for (const entry of entries) {
      if (entry.applicable && entry.recipe) {
        names.set(entry.recipe.name, (names.get(entry.recipe.name) ?? 0) + 1);
      }
    }
    return entries.map((entry) => (
      entry.applicable && entry.recipe && names.get(entry.recipe.name)! > 1
        ? { ...entry, error: `Duplicate applicable App name: ${entry.recipe.name}` }
        : entry
    ));
  }

  async function load(files?: readonly string[]): Promise<AppEntry[]> {
    if (files) {
      const selected = await Promise.all(files.map(read));
      const registered = files.some(isInRecipeDirectory) ? await load() : [];
      return rejectDuplicates(selected.map((entry) => (
        isInRecipeDirectory(entry.file)
          ? registered.find((item) => path.resolve(item.file) === path.resolve(entry.file)) ?? entry
          : entry
      )));
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const filesInDirectory = names.filter((name) => name.endsWith(".json")).sort();
    return rejectDuplicates(await Promise.all(filesInDirectory.map((name) => read(path.join(directory, name)))));
  }

  async function preview(entry: AppEntry) {
    if (!entry.recipe || entry.error) throw new Error(entry.error ?? "Invalid recipe");
    const recipe = entry.recipe;
    const steps = [
      ...Object.entries({
        install: recipe.install, update: recipe.update, uninstall: recipe.uninstall, version: recipe.version,
      }),
      ...(recipe.latest && "argv" in recipe.latest ? [["latest", recipe.latest] as const] : []),
      ...Object.entries(recipe.setup ?? {}).map(([host, step]) => [`setup.${host}`, step] as const),
      ...Object.entries(recipe.teardown ?? {}).map(([host, step]) => [`teardown.${host}`, step] as const),
    ];
    return Promise.all(steps.map(async ([step, value]) => {
      const resolution = value.argv ? await resolve(value.argv[0]) : undefined;
      return {
        step, ...value, executable: resolution?.executable, cwd: home,
        warning: resolution?.blocked ? WINDOWS_EXECUTABLE_WARNING : undefined,
      };
    }));
  }

  function isInRecipeDirectory(file: string): boolean {
    return path.dirname(path.resolve(file)) === path.resolve(directory);
  }

  async function approve(entry: AppEntry): Promise<void> {
    const [current] = await load([entry.file]);
    if (entry.error || current!.error || !current!.applicable || !current!.hash
      || current!.hash !== entry.hash || current!.canonicalFile !== entry.canonicalFile) {
      throw new Error("Recipe changed, invalid or not applicable; review it again");
    }
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await chmod(receipts, 0o700);
    await writeFileAtomically(receiptPath(entry), JSON.stringify({ hash: entry.hash }), { mode: 0o600 });
  }

  async function inspect(entry: AppEntry): Promise<AppInspection> {
    if (entry.error || !entry.recipe) return { status: "invalid", reason: entry.error };
    if (!entry.applicable) return { status: "not applicable here" };
    const [current] = await load([entry.file]);
    if (current!.error) return { status: "invalid", reason: current!.error };
    const { executable, blocked } = await resolve(entry.recipe.version.argv[0]);
    let approved = false;
    try {
      approved = JSON.parse(await readFile(receiptPath(entry), "utf8")).hash === entry.hash
        && current!.hash === entry.hash && current!.canonicalFile === entry.canonicalFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!approved) return { status: "needs approval", executable };
    if (!executable || blocked) {
      return { status: "not installed", executable, reason: blocked ? WINDOWS_EXECUTABLE_WARNING : undefined };
    }
    try {
      const result = await runner(executable, entry.recipe.version.argv.slice(1), {
        cwd: home, captureStdout: true, maxOutputBytes: 1024 * 1024,
      });
      const installedVersion = result.code === 0 && !result.signal && !result.outputTooLarge
        ? new RegExp(entry.recipe.version.pattern).exec(result.stdout.toString("utf8"))?.[1]
        : undefined;
      return installedVersion
        ? { status: "installed", executable, installedVersion }
        : { status: "not installed", executable };
    } catch {
      return { status: "not installed", executable };
    }
  }
  return { load, preview, approve, inspect };
}

export type AppOperations = ReturnType<typeof createAppOperations>;
