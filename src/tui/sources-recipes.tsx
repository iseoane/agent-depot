import { Box, Text, type Key } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createAppOperations, type AppEntry, type AppLifecyclePlan } from "../app-flow.js";
import { planAppRecipeRemoval, removeAppRecipe, type AppRecipeRemovalPlan } from "../app-recipe-removal.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../sources.js";
import { handleCatalogActionKey, type CatalogFlowContext } from "./catalog-flow.js";
import type { ActionMode } from "./catalog-actions.js";
import { ActionPanel } from "./catalog-panel.js";
import { hasUnmanagedCopy, isInstalled, loadInstalledSkills } from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { appName, appStepLines } from "./app-actions.js";
import { errorText } from "./batch.js";
import { useMounted } from "./view-state.js";
import { PreviewConfirm } from "./panel-parts.js";
import { answerYesNo } from "./mode-keys.js";
import { theme } from "./theme.js";

/** One recipe file with its command-free approval status. */
export interface RecipeRow {
  readonly entry: AppEntry;
  readonly status: string;
}

/** Captured approval, guide and delegated Catalog install interactions. */
type RecipeMode =
  | { readonly kind: "browse" }
  | { readonly kind: "busy" }
  | { readonly kind: "guide" | "manual" | "prompt" }
  | { readonly kind: "install"; readonly action: ActionMode }
  | { readonly kind: "approve"; readonly entry: AppEntry; readonly lines: readonly string[]; readonly removeAfterApproval?: boolean }
  | { readonly kind: "uninstall-question" | "remove"; readonly removal: AppRecipeRemovalPlan }
  | { readonly kind: "uninstall-confirm" | "uninstall-manual"; readonly removal: AppRecipeRemovalPlan; readonly plan: AppLifecyclePlan };

interface RecipeSectionOptions {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  readonly onCapturingChange?: (value: boolean) => void;
  readonly highlightedFile: () => string | undefined;
}

/**
 * Recipe loading and captured actions; Sources owns the single list and cursor.
 */
export function useSourcesRecipes({
  operations,
  environment,
  onCapturingChange,
  highlightedFile,
}: RecipeSectionOptions) {
  const homeDirectory = environment?.homeDirectory;
  const appEnvironment = environment?.appEnvironment;
  const apps = useMemo(() => createAppOperations({
    homeDirectory,
    ...appEnvironment,
  }), [homeDirectory, appEnvironment]);
  const mounted = useMounted();
  const [rows, setRows] = useState<readonly RecipeRow[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [mode, setModeState] = useState<RecipeMode>({ kind: "browse" });
  const modeRef = useRef<RecipeMode>(mode);
  const setMode = (next: RecipeMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  };
  const finish = async () => {
    await reload();
    if (mounted.current) setMode({ kind: "browse" });
  };
  const preview = async (entry: AppEntry, status: string, removeAfterApproval = false) => {
    setError(undefined);
    setMode({ kind: "busy" });
    try {
      const steps = await apps.preview(entry);
      if (mounted.current) {
        setMode({
          kind: "approve",
          entry, removeAfterApproval,
          lines: [
            `File: ${entry.file}`,
            `Platform: ${entry.recipe?.platform ?? "all"}`,
            `Status: ${status}`,
            ...steps.flatMap(step => [step.step, ...appStepLines(step)]),
          ],
        });
      }
    } catch (error) {
      if (mounted.current) {
        setError(errorText(error));
        setMode({ kind: "browse" });
      }
    }
  };
  const flow: CatalogFlowContext = {
    operations,
    env: environment ?? {},
    isMounted: () => mounted.current,
    setAction: action => setMode(action.kind === "browse"
      ? { kind: "browse" }
      : { kind: "install", action }),
    setMessage: message => {
      if (mounted.current) setError(message?.text);
    },
    keepMarked: () => undefined,
    finish: async result => {
      if (mounted.current) {
        setError(result.kind === "error" ? result.text : undefined);
        setMode({ kind: result.kind === "ok" ? "prompt" : "browse" });
      }
    },
  };
  const startAI = async () => {
    setMode({ kind: "busy" });
    try {
      if (!operations.discoverSkills) throw new Error("Discovery is not supported by the configured operations");
      const [skills, installed] = await Promise.all([
        operations.discoverSkills([BUILT_IN_SOURCE.id]),
        loadInstalledSkills(operations, environment ?? {}),
      ]);
      const skill = skills.find(skill => skill.name === "agent-depot-apprecipe");
      if (!skill) throw new Error("Built-in agent-depot-apprecipe Skill is unavailable");
      if (!mounted.current) return;
      if (isInstalled(skill, installed) || hasUnmanagedCopy(skill, installed)) {
        setMode({ kind: "prompt" });
      } else {
        flow.setAction({ kind: "host", skills: [skill], cursor: 0, selected: [] });
      }
    } catch (error) {
      if (mounted.current) {
        setError(errorText(error));
        setMode({ kind: "browse" });
      }
    }
  };
  const startRemoval = async (entry: AppEntry) => {
    setError(undefined);
    setMode({ kind: "busy" });
    try {
      const approval = await apps.approvalStatus(entry);
      if (approval.status === "needs approval") {
        await preview(entry, approval.status, true);
        return;
      }
      const removal = await planAppRecipeRemoval(apps, entry);
      if (mounted.current) setMode({ kind: removal.installed ? "uninstall-question" : "remove", removal });
    } catch (error) {
      if (mounted.current) {
        setError(errorText(error));
        setMode({ kind: "browse" });
      }
    }
  };
  const uninstall = async (current: Extract<RecipeMode, { kind: "uninstall-confirm" | "uninstall-manual" }>) => {
    setMode({ kind: "busy" });
    try {
      const result = current.kind === "uninstall-manual"
        ? await apps.completeManual(current.plan, true)
        : await apps.executeLifecycle(current.plan, true);
      if (!mounted.current) return;
      if (result.status === "manual required") setMode({ ...current, kind: "uninstall-manual" });
      else if (result.status === "untracked") setMode({ kind: "remove", removal: current.removal });
      else {
        setError(`Uninstall failed: ${result.reason ?? result.status}; recipe retained`);
        setMode({ kind: "browse" });
      }
    } catch (error) {
      if (mounted.current) {
        setError(`Uninstall failed: ${errorText(error)}; recipe retained`);
        setMode({ kind: "browse" });
      }
    }
  };
  const startAdd = () => {
    setError(undefined);
    setMode({ kind: "guide" });
  };
  /** Captured actions take priority; browse actions use the unified cursor's recipe. */
  const handleKey = (input: string, key: Key): boolean => {
    const current = modeRef.current;
    if (current.kind === "busy") return true;
    if (current.kind === "install") {
      const decline = input === "n" && ["host", "scope", "version"].includes(current.action.kind);
      handleCatalogActionKey(flow, current.action, input, decline ? { ...key, escape: true } : key);
      return true;
    }
    if (current.kind === "guide" || current.kind === "manual" || current.kind === "prompt") {
      if (key.escape || input === "n") { setMode({ kind: "browse" }); void reload(); }
      else if (current.kind === "guide" && input === "1") void startAI();
      else if (current.kind === "guide" && input === "2") setMode({ kind: "manual" });
      return true;
    }
    const cancel = () => setMode({ kind: "browse" });
    if (current.kind === "approve") {
      answerYesNo(input, key, () => {
        setMode({ kind: "busy" });
        void apps.approve(current.entry).then(async () => {
          await reload();
          if (!mounted.current) return;
          if (current.removeAfterApproval) await startRemoval(current.entry);
          else setMode({ kind: "browse" });
        }, error => {
          if (mounted.current) { setError(errorText(error)); cancel(); }
        });
      }, cancel);
      return true;
    }
    if (current.kind === "uninstall-question") {
      answerYesNo(input, key, () => {
        setMode({ kind: "busy" });
        void apps.planLifecycle(current.removal.entry, "uninstall").then(plan => {
          if (mounted.current) setMode({ kind: !plan.argv && plan.manual ? "uninstall-manual" : "uninstall-confirm", removal: current.removal, plan });
        }, error => { if (mounted.current) { setError(errorText(error)); cancel(); } });
      }, cancel);
      return true;
    }
    if (current.kind === "uninstall-confirm" || current.kind === "uninstall-manual") {
      answerYesNo(input, key, () => { void uninstall(current); }, cancel);
      return true;
    }
    if (current.kind === "remove") {
      answerYesNo(input, key, () => {
        setMode({ kind: "busy" });
        void removeAppRecipe(apps, current.removal, true).then(async () => {
          if (mounted.current) setNotice(`Removed App recipe: ${current.removal.file}`);
          await finish();
        }, error => {
          if (mounted.current) { setError(errorText(error)); cancel(); }
        });
      }, cancel);
      return true;
    }
    const row = rows.find(row => row.entry.file === highlightedFile());
    if (!row) return false;
    if (input === "n") startAdd();
    else if (input === "r") void reload();
    else if (key.return) void preview(row.entry, row.status);
    else if (input === "d") void startRemoval(row.entry);
    else return false;
    return true;
  };
  /** Reloads parsing and approval receipts, never version/latest commands. */
  const reload = useCallback(async () => {
    try {
      const entries = await apps.load();
      const rows = await Promise.all(entries.map(async entry => {
        const inspection = await apps.approvalStatus(entry);
        const status = inspection.status === "invalid"
          ? `invalid recipe: ${inspection.reason}`
          : inspection.status;
        return { entry, status };
      }));
      if (mounted.current) {
        setRows(rows);
        setLoadError(undefined);
      }
    } catch (error) {
      if (mounted.current) setLoadError(errorText(error));
    }
  }, [apps, mounted]);
  useEffect(() => { void reload(); }, [reload]);
  const panel = (
    <Box flexDirection="column">
      {loadError ? <Text color={theme.error}>Error loading App recipes: {loadError}</Text> : null}
      {error ? <Text color={theme.error}>{error}</Text> : null}
      {notice ? <Text color={theme.success}>{notice}</Text> : null}
      {mode.kind === "guide" ? (
        <Text>
          {"1 With the AI skill · install if missing, then copy the prompt\n"}
          {"2 Manual · write a recipe using the schema\nn or Esc closes"}
        </Text>
      ) : null}
      {mode.kind === "manual" ? (
        <Text>
          Write a JSON recipe in {apps.directory}{"\n"}
          Schema: agent-depot app schema · n or Esc closes
        </Text>
      ) : null}
      {mode.kind === "prompt" ? (
        <Text>
          Use the agent-depot-apprecipe skill to create the recipe for &lt;app&gt;{"\n"}
          Recipes: {apps.directory} · n or Esc closes
        </Text>
      ) : null}
      {mode.kind === "install" ? <ActionPanel mode={mode.action} /> : null}
      {mode.kind === "busy" ? <Text>Working...</Text> : null}
      {mode.kind === "approve" ? (
        <PreviewConfirm lines={mode.lines} question={`Approve ${appName(mode.entry)}? y/n`} />
      ) : null}
      {mode.kind === "uninstall-question" ? (
        <Text>App {appName(mode.removal.entry)} is installed or tracked{mode.removal.installedVersion ? ` (${mode.removal.installedVersion})` : ""}. Uninstall it before removing the recipe? y/n (n cancels removal)</Text>
      ) : null}
      {mode.kind === "uninstall-confirm" || mode.kind === "uninstall-manual" ? (
        <PreviewConfirm lines={appStepLines(mode.plan)} question={mode.kind === "uninstall-manual"
          ? "Complete the manual uninstall, then check now? y/n"
          : `Uninstall ${appName(mode.removal.entry)}? y/n`} />
      ) : null}
      {mode.kind === "remove" ? (
        <PreviewConfirm lines={[`Delete recipe: ${mode.removal.file}`, "Only this recipe file or symlink will be removed; App data and Host configuration are not deleted."]}
          question={`Remove recipe for ${appName(mode.removal.entry)}? y/n`} />
      ) : null}
    </Box>
  );
  return { rows, handleKey, startAdd, reload, clearMessage: () => { setError(undefined); setNotice(undefined); }, panel, directory: apps.directory };
}
