import { readFile } from "node:fs/promises";
import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAppOperations } from "../app-flow.js";
import { buildProfileExport, profileExportPreview, writeProfileExport } from "../profile-export.js";
import { applyProfileImport, buildProfileImport, type ProfileImportPlan } from "../profile-import.js";
import { type Profile } from "../profile.js";
import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { useKeys } from "./keys.js";
import { answerYesNo, moveCursor, toggleChoice } from "./mode-keys.js";
import { ChecklistLines, PreviewConfirm, PreviewLines } from "./panel-parts.js";
import { computeWindow, useListHeight } from "./window.js";

type Mode = "browse" | "busy" | "export-list" | "import-list" | "export-path" | "import-path" | "confirm" | "results";
interface Row { readonly block: "sources" | "skills" | "apps"; readonly index: number; readonly label: string; readonly selectable: boolean }

export function ProfileView({ operations, environment = {}, onCapturingChange, listHeight }: {
  readonly operations: SourceOperations; readonly environment?: TuiEnvironment;
  readonly onCapturingChange?: (value: boolean) => void; readonly listHeight?: number;
}) {
  const apps = useMemo(() => createAppOperations({ homeDirectory: environment.homeDirectory, ...environment.appEnvironment }), [environment]);
  const [mode, setModeState] = useState<Mode>("browse");
  const modeRef = useRef<Mode>("browse");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setMode = (next: Mode) => {
    modeRef.current = next;
    onCapturingChange?.(next !== "browse" && next !== "results");
    setModeState(next);
  };
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [selected, setSelectedState] = useState<readonly Row[]>([]);
  const selectedRef = useRef<readonly Row[]>([]);
  const select = (next: readonly Row[]) => { selectedRef.current = next; setSelectedState(next); };
  const [cursor, setCursorState] = useState(0);
  const cursorRef = useRef(0);
  const cursorTo = (next: number) => { cursorRef.current = next; setCursorState(next); };
  const [text, setText] = useState("");
  const typed = useRef("");
  const [lines, setLines] = useState<readonly string[]>([]);
  const [profile, setProfile] = useState<Profile>();
  const [plan, setPlan] = useState<ProfileImportPlan>();
  const exclusions = useRef<readonly string[]>([]);
  const action = useRef<"export" | "import">("export");
  const height = useListHeight(listHeight, 5);
  const run = async (work: () => Promise<void>) => {
    setMode("busy");
    try { await work(); }
    catch (error) {
      if (mounted.current) { setLines([`Error: ${error instanceof Error ? error.message : String(error)}`]); cursorTo(0); setMode("results"); }
    }
  };
  const prompt = (next: Mode) => { typed.current = ""; setText(""); setMode(next); };
  const loadRows = (next: readonly Row[], nextMode: Mode) => {
    setRows(next); select(next.filter(row => row.selectable)); cursorTo(0); setMode(nextMode);
  };
  const chosenProfile = (): Profile => {
    const chosen = selectedRef.current;
    return { ...profile!, sources: profile!.sources.filter((_, index) => chosen.some(row => row.block === "sources" && row.index === index)),
      skills: profile!.skills.filter((_, index) => chosen.some(row => row.block === "skills" && row.index === index)),
      apps: profile!.apps.filter((_, index) => chosen.some(row => row.block === "apps" && row.index === index)) };
  };
  useKeys((input, key) => {
    const current = modeRef.current;
    if (current === "busy") return;
    if (current === "browse" || current === "results") {
      if (input === "e") {
        action.current = "export";
        void run(async () => {
          const exported = await buildProfileExport(operations, apps, { homeDirectory: environment.homeDirectory });
          if (!mounted.current) return;
          setProfile(exported.profile);
          exclusions.current = exported.preview.filter(line => line.startsWith("Excluded") || (line.startsWith("WARNING:") && !line.includes("not included in profile")));
          loadRows([
            ...exported.profile.sources.map((value, index): Row => ({ block: "sources", index, label: `Sources: ${value.url}`, selectable: true })),
            ...exported.profile.skills.map((value, index): Row => ({ block: "skills", index, label: `Skills: ${value.path}`, selectable: true })),
            ...exported.profile.apps.map((value, index): Row => ({ block: "apps", index, label: `Apps: ${value.name} (${value.platform ?? "all platforms"})`, selectable: true })),
            ...exclusions.current.map((label, index): Row => ({ block: "apps", index: -index - 1, label, selectable: false })),
          ], "export-list");
        });
      } else if (input === "i") { action.current = "import"; prompt("import-path"); }
      else if (current === "results") {
        const next = moveCursor(cursorRef.current, lines.length, input, key);
        if (next !== undefined) cursorTo(Math.max(0, next));
      }
      return;
    }
    if (current === "export-path" || current === "import-path") {
      if (key.escape) { setMode("browse"); return; }
      if (key.return && typed.current.trim()) {
        if (current === "export-path") { setLines(profileExportPreview(chosenProfile(), exclusions.current)); cursorTo(0); setMode("confirm"); }
        else void run(async () => {
          const input = JSON.parse(await readFile(typed.current, "utf8"));
          const imported = await buildProfileImport(input, operations, apps);
          profileVersion.current = input.agentDepotVersion;
          if (!mounted.current) return;
          setPlan(imported);
          loadRows(imported.items.map((item, index) => ({ block: item.block, index,
            label: `${item.block}: ${item.status}: ${item.label}${item.difference ? `; ${item.difference}` : ""}`, selectable: item.status === "add" })), "import-list");
        });
      } else if (key.backspace || key.delete) { typed.current = typed.current.slice(0, -1); setText(typed.current); }
      else if (input && !key.ctrl && !key.meta) { typed.current += input; setText(typed.current); }
      return;
    }
    if (current === "confirm") {
      answerYesNo(input, key, () => {
        void run(async () => {
          let result: readonly string[];
          if (action.current === "export") {
            await writeProfileExport(typed.current, chosenProfile());
            result = [`Exported profile to ${typed.current}`];
          } else {
            const confirmed = { ...plan!, items: plan!.items.filter((item, index) => item.status !== "add" || selectedRef.current.some(row => row.index === index)) };
            const outcomes = await applyProfileImport(confirmed, operations, apps, true, () => undefined,
              { homeDirectory: environment.homeDirectory, ...environment.installationOptions });
            result = outcomes.map(outcome => `${outcome.status}: ${outcome.item.label}${outcome.detail ? `; ${outcome.detail}` : ""}`);
          }
          if (mounted.current) { setLines(result.length ? result : ["Nothing selected; nothing written."]); cursorTo(0); setMode("results"); }
        });
      }, () => setMode("browse"));
      const next = moveCursor(cursorRef.current, lines.length, input, key);
      if (next !== undefined) cursorTo(Math.max(0, next));
      return;
    }
    if (key.escape) { setMode("browse"); return; }
    const next = moveCursor(cursorRef.current, rows.length, input, key);
    if (next !== undefined) cursorTo(Math.max(0, next));
    else if (input === " " && rows[cursorRef.current]?.selectable) select(toggleChoice(rows, selectedRef.current, rows[cursorRef.current]!));
    else if (input === "a") select(selectedRef.current.length ? [] : rows.filter(row => row.selectable));
    else if (key.return) {
      if (current === "export-list") prompt("export-path");
      else void run(async () => {
        // Reuse the CLI's core preview for the exact selected subset, including argv and Source notes.
        const items = plan!.items.filter((item, index) => item.status !== "add" || selectedRef.current.some(row => row.index === index));
        const preview = await buildProfileImport({ format: "agent-depot-profile/v1", agentDepotVersion: profileVersion.current,
          sources: items.filter(item => item.block === "sources").map(item => item.value),
          skills: items.filter(item => item.block === "skills").map(item => item.value),
          apps: items.filter(item => item.block === "apps").map(item => item.value) }, operations, apps);
        if (mounted.current) { setLines(preview.preview); cursorTo(0); setMode("confirm"); }
      });
    }
  });
  const profileVersion = useRef("");
  const listing = mode === "export-list" || mode === "import-list";
  const window = computeWindow(listing ? rows.length : lines.length, cursor, height);
  return <Box flexDirection="column">
    <Text bold>Portable user-global Profile · e export · i import</Text>
    {mode === "busy" ? <Text>Loading Profile…</Text> : null}
    {mode.endsWith("-path") ? <Text>Profile path: {text}_</Text> : null}
    {listing ? <ChecklistLines choices={rows.slice(window.start, window.end)} cursor={cursor - window.start}
      isSelected={row => selected.includes(row)} keyOf={row => `${row.block}:${row.index}`}
      label={row => `${row.label}${row.selectable ? "" : " (not selectable)"}`} /> : null}
    {mode === "confirm" ? <PreviewConfirm lines={lines.slice(window.start, window.end)} question="Apply Profile? (y/n) · j/k scroll" /> : null}
    {mode === "results" ? <PreviewLines lines={lines.slice(window.start, window.end)} /> : null}
    {window.indicator && (listing || mode === "confirm" || mode === "results") ? <Text>{window.indicator}</Text> : null}
    {listing ? <Text>j/k move · space toggle · a all · Enter preview · Esc cancel</Text> : null}
  </Box>;
}
