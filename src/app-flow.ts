import { access, chmod, mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { compareAppVersions, sameAppVersion } from "./app-version.js";
import { fetchAppLatest } from "./app-latest.js";
import { writeFileAtomically } from "./atomic-file.js";
import { parseAppRecipe, type AppRecipe, type AppStep } from "./app-recipes.js";
import { type ProjectHost } from "./project-manifest.js";
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

export interface AppUpdateCheck {
  readonly entry: AppEntry;
  readonly inspection: AppInspection;
  readonly status: "unknown" | "current" | "update available";
  readonly installedVersion?: string;
  readonly latestVersion?: string;
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
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveExecutable?: (name: string) => Promise<string | undefined>;
}

export interface AppLifecyclePlan extends AppStep {
  readonly entry: AppEntry;
  readonly action: "install" | "update" | "uninstall" | "setup" | "teardown";
  readonly host?: ProjectHost;
  readonly previousVersion?: string;
  readonly latestVersion?: string;
  readonly executable?: string;
  readonly warning?: string;
  readonly cwd: string;
  readonly environment: string;
}

export interface TrackedApp {
  readonly name: string;
  readonly recipeFile: string;
  readonly installedVersion: string;
}

export interface AppLifecycleResult {
  readonly status: "installed" | "untracked" | "manual required" | "failed" | "completed";
  readonly manual?: string;
  readonly previousVersion?: string;
  readonly installedVersion?: string;
  readonly latestVersion?: string;
  readonly reason?: string;
}

const APP_OUTPUT_LIMIT = 1024 * 1024;
const DIAGNOSTIC_BYTES = 4096;

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

  async function approvalProblem(entry: AppEntry): Promise<AppInspection | undefined> {
    if (entry.error || !entry.recipe) return { status: "invalid", reason: entry.error };
    if (!entry.applicable) return { status: "not applicable here" };
    const [current] = await load([entry.file]);
    if (current!.error) return { status: "invalid", reason: current!.error };
    let approved = false;
    try {
      approved = JSON.parse(await readFile(receiptPath(entry), "utf8")).hash === entry.hash
        && current!.hash === entry.hash && current!.canonicalFile === entry.canonicalFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!approved) {
      const { executable } = await resolve(entry.recipe!.version.argv[0]);
      return { status: "needs approval", executable };
    }
    return undefined;
  }

  /** A supplied cache checks recipe approval without running version; omit it for a live check. */
  async function inspect(entry: AppEntry, cached?: { installedVersion?: string }): Promise<AppInspection> {
    if (entry.error || !entry.recipe) return { status: "invalid", reason: entry.error };
    if (!entry.applicable) return { status: "not applicable here" };
    const approval = await approvalProblem(entry);
    if (approval) return approval;
    if (cached) return cached.installedVersion
      ? { status: "installed", installedVersion: cached.installedVersion } : { status: "not installed" };
    const { executable, blocked } = await resolve(entry.recipe.version.argv[0]);
    if (!executable || blocked) {
      return { status: "not installed", executable, reason: blocked ? WINDOWS_EXECUTABLE_WARNING : undefined };
    }
    try {
      const result = await runner(executable, entry.recipe.version.argv.slice(1), {
        cwd: home, captureStdout: true, maxOutputBytes: APP_OUTPUT_LIMIT, maxStderrBytes: APP_OUTPUT_LIMIT,
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
  async function checkUpdate(entry: AppEntry): Promise<AppUpdateCheck> {
    const inspection = await inspect(entry);
    let latestVersion: string | undefined;
    let reason = inspection.status === "installed" ? "latest not declared" : inspection.reason ?? inspection.status;
    if (inspection.status === "installed" && entry.recipe?.latest) {
      try {
        const latest = entry.recipe.latest;
        reason = "latest executable unavailable";
        if ("argv" in latest) {
          const approval = await approvalProblem(entry);
          if (approval) reason = approval.reason ?? approval.status;
          if (!approval) {
            const { executable, blocked } = await resolve(latest.argv[0]);
            if (executable && !blocked) {
              reason = "latest command failed";
              const result = await runner(executable, latest.argv.slice(1), {
                cwd: home, captureStdout: true, maxOutputBytes: APP_OUTPUT_LIMIT, maxStderrBytes: APP_OUTPUT_LIMIT,
              });
              if (result.code === 0 && !result.signal && !result.outputTooLarge) {
                latestVersion = new RegExp(latest.pattern).exec(result.stdout.toString("utf8"))?.[1];
                reason = "invalid response";
              }
            }
          }
        } else {
          const lookup = await fetchAppLatest(latest, environment.fetch ?? globalThis.fetch);
          latestVersion = lookup.latestVersion;
          reason = lookup.reason ?? "invalid response";
        }
      } catch { reason = "latest lookup failed"; }
    }
    const comparison = latestVersion && inspection.installedVersion
      ? compareAppVersions(inspection.installedVersion, latestVersion) : undefined;
    const status = !latestVersion || !inspection.installedVersion ? "unknown" as const
      : (comparison !== undefined ? comparison >= 0 : sameAppVersion(latestVersion, inspection.installedVersion)) ? "current" as const
      : "update available" as const;
    return { entry, inspection, installedVersion: inspection.installedVersion, status, latestVersion,
      reason: status === "unknown" ? reason : undefined };
  }
  const installations = path.join(path.dirname(directory), "app-installations");
  const installationPath = (name: string) => path.join(
    installations, createHash("sha256").update(name).digest("hex") + ".json",
  );

  async function trackedApps(
    reportWarning: (warning: string) => void = warning => process.emitWarning(warning),
  ): Promise<TrackedApp[]> {
    let files: string[];
    try { files = await readdir(installations); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: TrackedApp[] = [];
    for (const file of files.filter(file => file.endsWith(".json")).sort()) {
      try {
        const record: unknown = JSON.parse(await readFile(path.join(installations, file), "utf8"));
        if (!record || typeof record !== "object"
          || !("name" in record) || typeof record.name !== "string" || !record.name
          || !("recipeFile" in record) || typeof record.recipeFile !== "string" || !record.recipeFile
          || !("installedVersion" in record) || typeof record.installedVersion !== "string" || !record.installedVersion
          || path.basename(installationPath(record.name)) !== file) {
          throw new Error("invalid record fields or identity");
        }
        records.push({ name: record.name, recipeFile: record.recipeFile, installedVersion: record.installedVersion });
      } catch (error) {
        reportWarning(`Skipping App installation record ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records;
  }

  async function previewForget(name: string): Promise<{ name: string; file: string }> {
    const file = installationPath(name);
    try { await access(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No tracked App found");
      throw error;
    }
    return { name, file };
  }

  async function planStep(entry: AppEntry, action: AppLifecyclePlan["action"], host?: ProjectHost): Promise<AppLifecyclePlan> {
    const approval = await approvalProblem(entry);
    if (approval) throw new Error(approval.reason ?? approval.status);
    const hostAction = action === "setup" || action === "teardown";
    const step = hostAction ? (host ? entry.recipe![action]?.[host] : undefined) : entry.recipe![action];
    if (!step || (host && !hostAction)) throw new Error("No declared App step for the requested Host/action");
    const resolution = step.argv ? await resolve(step.argv[0]) : undefined;
    return Object.freeze({ entry, action, host, ...step, executable: resolution?.executable,
      warning: resolution?.blocked ? WINDOWS_EXECUTABLE_WARNING : undefined,
      cwd: home, environment: isWsl ? "linux (WSL)" : platform });
  }

  async function planLifecycle(
    entry: AppEntry, action: AppLifecyclePlan["action"], host?: ProjectHost, loadedUpdate?: AppUpdateCheck,
  ): Promise<AppLifecyclePlan> {
    const plan = await planStep(entry, action, host);
    if (action !== "update") return plan;
    if (loadedUpdate && (loadedUpdate.entry.canonicalFile !== entry.canonicalFile || loadedUpdate.entry.hash !== entry.hash)) {
      throw new Error("Update check belongs to a different recipe; check again");
    }
    const update = loadedUpdate ?? await checkUpdate(entry);
    if (!update.installedVersion) throw new Error("Update requires a successful installed version check");
    return Object.freeze({ ...plan, previousVersion: update.installedVersion, latestVersion: update.latestVersion });
  }

  async function recheckPlan(plan: AppLifecyclePlan): Promise<void> {
    const current = await planStep(plan.entry, plan.action, plan.host);
    const sameArgv = current.argv?.length === plan.argv?.length
      && current.argv?.every((arg, index) => arg === plan.argv?.[index]) !== false;
    if (!sameArgv || current.executable !== plan.executable || current.warning !== plan.warning
      || current.manual !== plan.manual || current.entry.hash !== plan.entry.hash
      || current.cwd !== plan.cwd || current.environment !== plan.environment) {
      throw new Error("App step changed; review the preview again");
    }
  }

  async function recordOutcome(plan: AppLifecyclePlan, manual = false): Promise<AppLifecycleResult> {
    if (plan.action === "setup" || plan.action === "teardown") {
      if (manual) {
        const inspection = await inspect(plan.entry);
        if (inspection.status !== "installed") {
          return { status: "failed", reason: `Version did not confirm installation (${inspection.status}); Host wiring is not verified` };
        }
      }
      return { status: "completed" };
    }
    const inspection = await inspect(plan.entry);
    const name = plan.entry.recipe!.name;
    if ((plan.action === "install" || plan.action === "update") && inspection.status === "installed") {
      if (plan.action === "update" && (!plan.previousVersion || sameAppVersion(inspection.installedVersion!, plan.previousVersion))) {
        return { status: "failed", reason: `version unchanged (${plan.previousVersion ?? "unknown"}); expected ${plan.latestVersion ?? "unknown"}` };
      }
      await mkdir(installations, { recursive: true, mode: 0o700 });
      await chmod(installations, 0o700);
      await writeFileAtomically(installationPath(name), JSON.stringify({
        name, recipeFile: plan.entry.canonicalFile, installedVersion: inspection.installedVersion,
      }), { mode: 0o600 });
      if (plan.action === "update") await clearPendingUpdate(name);
      return { status: "installed", previousVersion: plan.previousVersion,
        installedVersion: inspection.installedVersion, latestVersion: plan.latestVersion };
    }
    if (plan.action === "uninstall" && inspection.status === "not installed") {
      await forgetApp(name, true);
      return { status: "untracked" };
    }
    return { status: "failed", reason: plan.action !== "uninstall"
      ? `Version did not confirm installation (${inspection.status}); tracking unchanged`
      : `Version still succeeds or cannot be checked (${inspection.status}); tracking retained` };
  }

  async function executeLifecycle(plan: AppLifecyclePlan, confirmed: boolean): Promise<AppLifecycleResult> {
    if (!confirmed) throw new Error("App step not confirmed; review and confirm first");
    await recheckPlan(plan);
    if (!plan.argv || !plan.executable || plan.warning) return manualFallback(plan);
    let result;
    try {
      result = await runner(plan.executable, plan.argv.slice(1), {
        cwd: home, captureStdout: true, maxOutputBytes: APP_OUTPUT_LIMIT, maxStderrBytes: APP_OUTPUT_LIMIT,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (!code || !["ENOENT", "EACCES", "ENOEXEC", "EPERM"].includes(code)) throw error;
      return manualFallback(plan, error instanceof Error ? error.message : String(error));
    }
    if (result.code !== 0 || result.signal || result.outputTooLarge) {
      const reason = result.outputTooLarge ? `output exceeded ${APP_OUTPUT_LIMIT} bytes`
        : `exit ${result.code}, signal ${result.signal}`;
      const stdout = result.stdout.subarray(-DIAGNOSTIC_BYTES).toString("utf8");
      const stderr = Buffer.from(result.stderr).subarray(-DIAGNOSTIC_BYTES).toString("utf8");
      return { status: "failed", reason: `App step failed (${reason}): ${stdout} ${stderr}` };
    }
    return recordOutcome(plan);
  }

  const pendingUpdates = path.join(path.dirname(directory), "app-pending-updates");
  const pendingUpdatePath = (name: string) => path.join(pendingUpdates, path.basename(installationPath(name)));

  async function clearPendingUpdate(name: string): Promise<void> {
    await unlink(pendingUpdatePath(name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async function manualFallback(plan: AppLifecyclePlan, reason = "Executable unavailable"): Promise<AppLifecycleResult> {
    if (plan.action === "update" && plan.manual) {
      await mkdir(pendingUpdates, { recursive: true, mode: 0o700 });
      await chmod(pendingUpdates, 0o700);
      await writeFileAtomically(pendingUpdatePath(plan.entry.recipe!.name), JSON.stringify({
        recipeFile: plan.entry.canonicalFile, hash: plan.entry.hash,
        previousVersion: plan.previousVersion, latestVersion: plan.latestVersion,
      }), { mode: 0o600 });
    }
    return plan.manual ? { status: "manual required", manual: plan.manual, reason }
      : { status: "failed", reason };
  }

  /** Cancels manual update evidence without attesting completion or changing tracking. */
  async function cancelManual(plan: AppLifecyclePlan): Promise<void> {
    if (plan.action === "update") await clearPendingUpdate(plan.entry.recipe!.name);
  }

  async function completeManual(plan: AppLifecyclePlan, done: boolean): Promise<AppLifecycleResult> {
    if (!done) throw new Error("Manual step completion not confirmed");
    try {
      // Installation/removal may legitimately change PATH resolution during manual work.
      const approval = await approvalProblem(plan.entry);
      if (approval) throw new Error(approval.reason ?? approval.status);
      if (!plan.manual) throw new Error("No manual step declared");
      if (plan.action === "update") {
        try {
          const pending = JSON.parse(await readFile(pendingUpdatePath(plan.entry.recipe!.name), "utf8"));
          if (pending.recipeFile !== plan.entry.canonicalFile || pending.hash !== plan.entry.hash
            || typeof pending.previousVersion !== "string" || !pending.previousVersion
            || (pending.latestVersion !== undefined && typeof pending.latestVersion !== "string")) {
            throw new Error("Manual update baseline changed; preview the update again");
          }
          plan = { ...plan, previousVersion: pending.previousVersion, latestVersion: pending.latestVersion };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return await recordOutcome(plan, true);
    } finally {
      // Attesting completion consumes the baseline even when verification fails.
      if (plan.action === "update") await clearPendingUpdate(plan.entry.recipe!.name);
    }
  }

  async function forgetApp(name: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("Forgetting an App requires explicit confirmation");
    await unlink(installationPath(name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  return { checkUpdate, load, preview, approve, inspect, planLifecycle, executeLifecycle, completeManual, cancelManual, trackedApps, previewForget, forgetApp };
}

export type AppOperations = ReturnType<typeof createAppOperations>;

/** Concurrent independent checks; one broken App must not hide the rest of a batch. */
export async function checkAppUpdates(apps: AppOperations): Promise<readonly AppUpdateCheck[]> {
  const entries = (await apps.load()).filter(entry => entry.applicable || entry.error);
  return Promise.all(entries.map(async entry => {
    try { return await apps.checkUpdate(entry); }
    catch (error) {
      const reason = `App check failed: ${error instanceof Error ? error.message : String(error)}`;
      return { entry, status: "unknown" as const, inspection: { status: "invalid" as const, reason }, reason };
    }
  }));
}
