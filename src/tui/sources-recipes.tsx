import { Box, Text, type Key } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createAppOperations, type AppEntry } from "../app-flow.js";
import { BUILT_IN_SOURCE, type SourceOperations } from "../sources.js";
import { handleCatalogActionKey, type CatalogFlowContext } from "./catalog-flow.js";
import type { ActionMode } from "./catalog-actions.js";
import { ActionPanel } from "./catalog-panel.js";
import { hasUnmanagedCopy, isInstalled, loadInstalledSkills } from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import { appStepLines } from "./app-actions.js";
import { errorText } from "./batch.js";
import { useMounted } from "./view-state.js";
import { PreviewConfirm } from "./panel-parts.js";
import { answerYesNo } from "./mode-keys.js";
import { rowStyle, theme } from "./theme.js";

interface RecipeRow {
  readonly entry: AppEntry;
  readonly status: string;
}

type RecipeMode =
  | { readonly kind: "browse" }
  | { readonly kind: "busy" }
  | { readonly kind: "guide" | "manual" | "prompt" }
  | { readonly kind: "install"; readonly action: ActionMode }
  | { readonly kind: "approve"; readonly entry: AppEntry; readonly lines: readonly string[] };

/** Sources owns key dispatch; only the focused section handles browse keys. */
export function useSourcesRecipes(operations: SourceOperations, environment?: TuiEnvironment, onCapturingChange?: (value: boolean) => void) {
  const apps = useMemo(() => createAppOperations({ homeDirectory: environment?.homeDirectory, ...environment?.appEnvironment }), [environment]);
  const mounted = useMounted();
  const [rows, setRows] = useState<readonly RecipeRow[]>([]);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [focused, setFocused] = useState(false);
  // Ref mirrors keep Tab and subsequent keys in a single burst on the same section.
  const focusRef = useRef(false);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
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
  const preview = async (entry: AppEntry, status: string) => {
    setError(undefined);
    setMode({ kind: "busy" });
    try {
      const steps = await apps.preview(entry);
      if (mounted.current) setMode({ kind: "approve", entry, lines: [
        `File: ${entry.file}`, `Platform: ${entry.recipe?.platform ?? "all"}`, `Status: ${status}`,
        ...steps.flatMap(step => [step.step, ...appStepLines(step)]),
      ] });
    } catch (error) {
      if (mounted.current) { setError(errorText(error)); setMode({ kind: "browse" }); }
    }
  };
  const flow: CatalogFlowContext = {
    operations, env: environment ?? {}, isMounted: () => mounted.current,
    setAction: action => setMode(action.kind === "browse" ? { kind: "browse" } : { kind: "install", action }),
    setMessage: message => { if (mounted.current) setError(message?.text); },
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
        operations.discoverSkills([BUILT_IN_SOURCE.id]), loadInstalledSkills(operations, environment ?? {}),
      ]);
      const skill = skills.find(skill => skill.name === "agent-depot-apprecipe");
      if (!skill) throw new Error("Built-in agent-depot-apprecipe Skill is unavailable");
      if (!mounted.current) return;
      if (isInstalled(skill, installed) || hasUnmanagedCopy(skill, installed)) setMode({ kind: "prompt" });
      else flow.setAction({ kind: "host", skills: [skill], cursor: 0, selected: [] });
    } catch (error) {
      if (mounted.current) { setError(errorText(error)); setMode({ kind: "browse" }); }
    }
  };
  const handleKey = (input: string, key: Key): boolean => {
    const current = modeRef.current;
    if (current.kind === "busy") return true;
    if (current.kind === "install") {
      handleCatalogActionKey(flow, current.action, input, key);
      return true;
    }
    if (current.kind === "guide" || current.kind === "manual" || current.kind === "prompt") {
      if (key.escape || input === "n") setMode({ kind: "browse" });
      else if (current.kind === "guide" && input === "1") void startAI();
      else if (current.kind === "guide" && input === "2") setMode({ kind: "manual" });
      return true;
    }
    if (current.kind === "approve") {
      answerYesNo(input, key, () => {
        setMode({ kind: "busy" });
        void apps.approve(current.entry).then(finish, error => {
          if (mounted.current) { setError(errorText(error)); setMode({ kind: "browse" }); }
        });
      }, () => setMode({ kind: "browse" }));
      return true;
    }
    if (key.tab) {
      focusRef.current = !focusRef.current;
      setFocused(focusRef.current);
      return true;
    }
    if (!focusRef.current) return false;
    if (key.downArrow || input === "j" || key.upArrow || input === "k") {
      indexRef.current = Math.min(Math.max(indexRef.current + (key.downArrow || input === "j" ? 1 : -1), 0), Math.max(rows.length - 1, 0));
      setIndex(indexRef.current);
    } else if (input === "n") { setError(undefined); setMode({ kind: "guide" }); }
    else if (input === "r") void reload();
    else if (key.return) {
      const row = rows[Math.min(indexRef.current, rows.length - 1)];
      if (row) void preview(row.entry, row.status);
    }
    return true;
  };
  const reload = useCallback(async () => {
    try {
      const entries = await apps.load();
      const rows = await Promise.all(entries.map(async entry => {
        const inspection = await apps.inspect(entry, {});
        const status = inspection.status === "invalid" ? `invalid recipe: ${inspection.reason}`
          : inspection.status === "not installed" ? "approved" : inspection.status;
        return { entry, status };
      }));
      if (mounted.current) { setRows(rows); setLoadError(undefined); }
    } catch (error) {
      if (mounted.current) setLoadError(errorText(error));
    }
  }, [apps, mounted]);
  useEffect(() => { void reload(); }, [reload]);
  return { focused, handleKey, panel: <Box flexDirection="column">
    <Text {...rowStyle(focused && rows.length === 0)}>App recipes · {apps.directory} · Tab switches section</Text>
    {focused ? <Text color={theme.muted}>j/k move · Enter preview · n add recipe · r reload</Text> : null}
    {loadError ? <Text color={theme.error}>Error loading App recipes: {loadError}</Text> : null}
    {error ? <Text color={theme.error}>{error}</Text> : null}
    {rows.map(({ entry, status }, position) =>
      <Text key={entry.file} {...rowStyle(focused && position === Math.min(index, rows.length - 1))}>{focused && position === Math.min(index, rows.length - 1) ? "> " : "  "}{entry.file.split(/[\\/]/u).pop()} · {status}</Text>)}
    {mode.kind === "guide" ? <Text>{"1 With the AI skill · install if missing, then copy the prompt\n2 Manual · write a recipe using the schema\nEsc closes"}</Text> : null}
    {mode.kind === "manual" ? <Text>Write a JSON recipe in {apps.directory}{"\n"}Schema: agent-depot app schema · Esc closes</Text> : null}
    {mode.kind === "prompt" ? <Text>Use the agent-depot-apprecipe skill to create the recipe for &lt;app&gt;{"\n"}Recipes: {apps.directory} · Esc closes</Text> : null}
    {mode.kind === "install" ? <ActionPanel mode={mode.action} /> : null}
    {mode.kind === "busy" ? <Text>Working...</Text> : null}
    {mode.kind === "approve" ? <PreviewConfirm lines={mode.lines} question={`Approve ${mode.entry.recipe?.name}? y/n`} /> : null}
  </Box> };
}
