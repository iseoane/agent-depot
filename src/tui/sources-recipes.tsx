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
import { appName, appRecipePreviewLines, appStepLines, recipeApprovalChrome } from "./app-actions.js";
import { errorText } from "./batch.js";
import { useMounted } from "./view-state.js";
import { BorderPanel, DecisionPrompt, PagedPreview, PreviewConfirm, Working } from "./panel-parts.js";
import { answerYesNo, movePreviewCursor } from "./mode-keys.js";
import { usePreviewGeometry, type PreviewChrome } from "./preview-window.js";
import { theme } from "./theme.js";
import { busy, type Busy } from "./working-model.js";

/** One recipe file with its command-free approval status. */
export interface RecipeRow {
  readonly entry: AppEntry;
  readonly status: string;
}

/** The recipes of one App name; `primary` is the one that applies on this machine, shown first. */
export interface RecipeGroup {
  readonly primary: RecipeRow;
  readonly members: readonly RecipeRow[];
}

/**
 * One group per App name. Invalid recipes, and recipes whose name clashes among those that apply here
 * (they carry an error), stay single rows so nothing is guessed.
 */
export function groupRecipeRows(rows: readonly RecipeRow[]): readonly RecipeGroup[] {
  const groups = new Map<string, RecipeRow[]>();
  for (const row of rows) {
    const key = row.entry.recipe !== undefined && row.entry.error === undefined ? `name:${row.entry.recipe.name}` : `file:${row.entry.file}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(found => {
    const members = [...found.filter(row => row.entry.applicable), ...found.filter(row => !row.entry.applicable)];
    return { primary: members[0]!, members };
  });
}

/** `windows · approved · <file> (used here)`, one line per recipe of a grouped App. */
function recipeMemberLine(row: RecipeRow): string {
  return `${row.entry.recipe?.platform ?? "all platforms"} · ${row.status} · ${row.entry.file}${row.entry.applicable ? " (used here)" : ""}`;
}

function uninstallChrome(mode: Extract<RecipeMode, { kind: "uninstall-confirm" | "uninstall-manual" }>): PreviewChrome {
  const name = appName(mode.removal.entry);
  return mode.kind === "uninstall-manual"
    ? { title: "App manual uninstall", action: "Check the uninstall now", consequence: "Complete the manual uninstall, then check now? y/n" }
    : { title: "App uninstall confirmation", action: `Uninstall ${name}`, consequence: `Uninstall ${name}? y/n` };
}

/** Captured approval, guide and delegated Catalog install interactions. */
type RecipeMode =
  | { readonly kind: "browse" }
  | Busy
  | { readonly kind: "guide" | "manual" | "prompt" }
  | { readonly kind: "install"; readonly action: ActionMode }
  | { readonly kind: "approve"; readonly entry: AppEntry; readonly lines: readonly string[]; readonly cursor: number; readonly removeAfterApproval?: boolean }
  | { readonly kind: "pick"; readonly members: readonly RecipeRow[] }
  | { readonly kind: "uninstall-question" | "remove"; readonly removal: AppRecipeRemovalPlan }
  | { readonly kind: "uninstall-confirm" | "uninstall-manual"; readonly removal: AppRecipeRemovalPlan; readonly plan: AppLifecyclePlan; readonly cursor: number };

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
  const previewGeometry = usePreviewGeometry();
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
  // When the oldest running reload began; reloads can overlap, so a count decides when loading ends.
  const [loadingSince, setLoadingSince] = useState<number | undefined>(() => Date.now());
  const reloading = useRef(0);
  const [mode, setModeState] = useState<RecipeMode>({ kind: "browse" });
  const modeRef = useRef<RecipeMode>(mode);
  const setMode = (next: RecipeMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  };
  /** Shows the busy panel; an operation already busy keeps its start time. */
  const setBusy = (label: string) => setMode(busy(label, modeRef.current));
  const finish = async () => {
    await reload();
    if (mounted.current) setMode({ kind: "browse" });
  };
  const preview = async (entry: AppEntry, status: string, removeAfterApproval = false, members: readonly RecipeRow[] = []) => {
    setError(undefined);
    setBusy("Preparing App recipe preview…");
    try {
      const steps = await apps.preview(entry);
      if (mounted.current) {
        setMode({
          kind: "approve",
          entry, removeAfterApproval, cursor: 0,
          lines: [
            ...(members.length > 1 ? [`Recipes named ${appName(entry)}:`, ...members.map(row => `  ${recipeMemberLine(row)}`), ""] : []),
            ...appRecipePreviewLines(entry, status, steps),
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
    setBusy("Checking the authoring Skill…");
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
    setBusy("Checking App recipe…");
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
    setBusy(current.kind === "uninstall-manual" ? "Checking App uninstall…" : "Uninstalling App…");
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
    if (current.kind === "pick") {
      const chosen = /^[1-9]$/u.test(input) ? current.members[Number(input) - 1] : undefined;
      if (chosen) void startRemoval(chosen.entry);
      else if (input === "n" || key.escape) cancel();
      return true;
    }
    if (current.kind === "approve") {
      const viewport = previewGeometry(current.lines, current.cursor, recipeApprovalChrome(current.entry));
      const cursor = movePreviewCursor(current.cursor, viewport.total, input, key, viewport.height);
      if (cursor !== undefined) setMode({ ...current, cursor });
      else if (input === "n" || key.escape) cancel();
      else if (input === "y" && viewport.reachedEnd) {
        setBusy("Approving App recipe…");
        void apps.approve(current.entry).then(async () => {
          await reload();
          if (!mounted.current) return;
          if (current.removeAfterApproval) await startRemoval(current.entry);
          else setMode({ kind: "browse" });
        }, error => {
          if (mounted.current) { setError(errorText(error)); cancel(); }
        });
      }
      return true;
    }
    if (current.kind === "uninstall-question") {
      answerYesNo(input, key, () => {
        setBusy("Preparing App uninstall…");
        void apps.planLifecycle(current.removal.entry, "uninstall").then(plan => {
          if (mounted.current) setMode({ kind: !plan.argv && plan.manual ? "uninstall-manual" : "uninstall-confirm", removal: current.removal, plan, cursor: 0 });
        }, error => { if (mounted.current) { setError(errorText(error)); cancel(); } });
      }, cancel);
      return true;
    }
    if (current.kind === "uninstall-confirm" || current.kind === "uninstall-manual") {
      const lines = appStepLines(current.plan);
      const viewport = previewGeometry(lines, current.cursor, uninstallChrome(current));
      const cursor = movePreviewCursor(current.cursor, viewport.total, input, key, viewport.height);
      if (cursor !== undefined) setMode({ ...current, cursor });
      else if (input === "n" || key.escape) cancel();
      else if (input === "y" && viewport.reachedEnd) void uninstall(current);
      return true;
    }
    if (current.kind === "remove") {
      answerYesNo(input, key, () => {
        setBusy("Removing App recipe…");
        void removeAppRecipe(apps, current.removal, true).then(async () => {
          if (mounted.current) setNotice(`Removed App recipe: ${current.removal.file}`);
          await finish();
        }, error => {
          if (mounted.current) { setError(errorText(error)); cancel(); }
        });
      }, cancel);
      return true;
    }
    const group = groupRecipeRows(rows).find(candidate => candidate.primary.entry.file === highlightedFile());
    if (!group) return false;
    const row = group.primary;
    if (input === "n") startAdd();
    else if (input === "r") void reload();
    else if (key.return) void preview(row.entry, row.status, false, group.members);
    // A grouped App names several files; the chosen one is the only file the removal flow may touch.
    else if (input === "d") {
      if (group.members.length > 1) setMode({ kind: "pick", members: group.members });
      else void startRemoval(row.entry);
    }
    else return false;
    return true;
  };
  /** Reloads parsing and approval receipts, never version/latest commands. */
  const reload = useCallback(async () => {
    if (reloading.current++ === 0 && mounted.current) setLoadingSince(Date.now());
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
    } finally {
      if (--reloading.current === 0 && mounted.current) setLoadingSince(undefined);
    }
  }, [apps, mounted]);
  useEffect(() => { void reload(); }, [reload]);
  const panel = (
    <Box flexDirection="column">
      {loadError ? <Text color={theme.error}>Error loading App recipes: {loadError}</Text> : null}
      {error ? <Text color={theme.error}>{error}</Text> : null}
      {notice ? <Text color={theme.success}>{notice}</Text> : null}
      {mode.kind === "guide" ? (
        <BorderPanel title="Add an App recipe">
          <Text>1 With the AI skill · install if missing, then copy the prompt</Text>
          <Text>2 Manual · write a recipe using the schema</Text>
          <Text>n or Esc closes</Text>
        </BorderPanel>
      ) : null}
      {mode.kind === "manual" ? (
        <BorderPanel title="Write an App recipe">
          <Text>Write a JSON recipe in {apps.directory}</Text>
          <Text>Schema: agent-depot app schema · n or Esc closes</Text>
        </BorderPanel>
      ) : null}
      {mode.kind === "prompt" ? (
        <BorderPanel title="App recipe authoring prompt">
          <Text>Use the agent-depot-apprecipe skill to create the recipe for &lt;app&gt;</Text>
          <Text>Recipes: {apps.directory} · n or Esc closes</Text>
        </BorderPanel>
      ) : null}
      {mode.kind === "install" ? <ActionPanel mode={mode.action} /> : null}
      {mode.kind === "busy" ? <BorderPanel title="App recipe workflow"><Working label={mode.label} since={mode.startedAt} /></BorderPanel> : null}
      {mode.kind === "approve" ? (() => {
        const chrome = recipeApprovalChrome(mode.entry);
        return <PagedPreview chrome={chrome} lines={mode.lines} viewport={previewGeometry(mode.lines, mode.cursor, chrome)} />;
      })() : null}
      {mode.kind === "pick" ? (
        <BorderPanel title="Remove which recipe?">
          {mode.members.map((row, index) => <Text key={row.entry.file}>{index + 1} {recipeMemberLine(row)}</Text>)}
          <Text color={theme.legend}>Press a number to review that one file for removal · n or Esc cancels</Text>
        </BorderPanel>
      ) : null}
      {mode.kind === "uninstall-question" ? (
        <BorderPanel title="Uninstall before recipe removal">
          <Text>App {appName(mode.removal.entry)} is installed or tracked{mode.removal.installedVersion ? ` (${mode.removal.installedVersion})` : ""}.</Text>
          <Text><DecisionPrompt>Uninstall it before removing the recipe?</DecisionPrompt><Text color={theme.legend}>(n cancels removal)</Text></Text>
        </BorderPanel>
      ) : null}
      {mode.kind === "uninstall-confirm" || mode.kind === "uninstall-manual" ? (() => {
        const chrome = uninstallChrome(mode);
        const lines = appStepLines(mode.plan);
        return <PagedPreview chrome={chrome} lines={lines} viewport={previewGeometry(lines, mode.cursor, chrome)} />;
      })() : null}
      {mode.kind === "remove" ? (
        <PreviewConfirm title="Recipe removal" lines={[`Delete recipe: ${mode.removal.file}`, "Only this recipe file or symlink will be removed; App data and Host configuration are not deleted."]}
          question={`Remove recipe for ${appName(mode.removal.entry)}? y/n`} />
      ) : null}
    </Box>
  );
  return { rows, loadingSince, handleKey, startAdd, reload, clearMessage: () => { setError(undefined); setNotice(undefined); }, panel, directory: apps.directory, capturing: mode.kind !== "browse" };
}
