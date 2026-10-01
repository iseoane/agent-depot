import { readFile } from "node:fs/promises";
import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAppOperations } from "../app-flow.js";
import {
  buildProfileExport, profileExportPreview, writeProfileExport,
  type ProfileExportDiagnostic, type ProfileExportPlan,
} from "../profile-export.js";
import {
  applyProfileImport, buildProfileImport, type ProfileImportItem, type ProfileImportPlan,
} from "../profile-import.js";
import { PROFILE_FORMAT } from "../profile.js";
import type { Profile } from "../profile.js";
import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { useKeys } from "./keys.js";
import { answerYesNo, moveCursor, toggleChoice } from "./mode-keys.js";
import { ChecklistLines, PreviewConfirm, PreviewLines } from "./panel-parts.js";
import { computeWindow, useListHeight } from "./window.js";

/** Input ownership and the stages of the two Profile workflows. */
type Mode = "browse" | "busy" | "export-list" | "import-list" | "export-path" | "import-path" | "confirm" | "results";

/** A choice's original block/index identity, or a non-selectable export diagnostic. */
interface Row {
  readonly block: "sources" | "skills" | "apps" | "excluded";
  readonly index: number;
  readonly label: string;
  readonly selectable: boolean;
}

function rowsFromExport(plan: ProfileExportPlan): readonly Row[] {
  return [
    ...plan.profile.sources.map((value, index): Row => ({
      block: "sources", index, label: `Sources: ${value.url}`, selectable: true,
    })),
    ...plan.profile.skills.map((value, index): Row => ({
      block: "skills", index, label: `Skills: ${value.path}`, selectable: true,
    })),
    ...plan.profile.apps.map((value, index): Row => ({
      block: "apps", index, label: `Apps: ${value.name} (${value.platform ?? "all platforms"})`, selectable: true,
    })),
    ...plan.exclusions.map((item, index): Row => ({
      block: "excluded", index, label: `Excluded ${item.label}: ${item.reason}`, selectable: false,
    })),
    ...plan.warnings.filter(warning => warning.kind === "load").map((warning, index): Row => ({
      block: "excluded", index: plan.exclusions.length + index, label: warning.message, selectable: false,
    })),
  ];
}

function rowsFromPlan(plan: ProfileImportPlan): readonly Row[] {
  return plan.items.map((item, index) => ({
    block: item.block, index,
    label: `${item.status}: ${item.label}${item.difference ? `; ${item.difference}` : ""}`,
    selectable: item.status === "add",
  }));
}

function selectedPlanItems(plan: ProfileImportPlan, selected: readonly Row[]): readonly ProfileImportItem[] {
  return plan.items.filter((item, index) => item.status !== "add" || selected.some(row => row.index === index));
}

/** Collect choices, display shared-core previews and confirm portable Profile transfers. */
export function ProfileView({ operations, environment = {}, onCapturingChange, listHeight }: {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  readonly onCapturingChange?: (value: boolean) => void;
  readonly listHeight?: number;
}) {
  const apps = useMemo(() => createAppOperations({
    homeDirectory: environment.homeDirectory, ...environment.appEnvironment,
  }), [environment]);
  const [mode, setModeState] = useState<Mode>("browse");
  const modeRef = useRef<Mode>("browse");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const setMode = (next: Mode) => {
    modeRef.current = next;
    onCapturingChange?.(next !== "browse" && next !== "results");
    setModeState(next);
  };
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [selected, setSelectedState] = useState<readonly Row[]>([]);
  const selectedRef = useRef<readonly Row[]>([]);
  const select = (next: readonly Row[]) => {
    selectedRef.current = next;
    setSelectedState(next);
  };
  const [cursor, setCursorState] = useState(0);
  const cursorRef = useRef(0);
  const cursorTo = (next: number) => {
    cursorRef.current = next;
    setCursorState(next);
  };
  const [text, setText] = useState("");
  const typed = useRef("");
  const [lines, setLines] = useState<readonly string[]>([]);
  const [profile, setProfile] = useState<Profile>();
  const [plan, setPlan] = useState<ProfileImportPlan>();
  const diagnostics = useRef<readonly ProfileExportDiagnostic[]>([]);
  const action = useRef<"export" | "import">("export");
  const profileVersion = useRef("");
  const height = useListHeight(listHeight, 9);
  const showLines = (next: readonly string[], nextMode: "confirm" | "results") => {
    setLines(next);
    cursorTo(0);
    setMode(nextMode);
  };
  const run = async (work: () => Promise<void>) => {
    setMode("busy");
    try { await work(); }
    catch (error) {
      if (mounted.current) {
        showLines([`Error: ${error instanceof Error ? error.message : String(error)}`], "results");
      }
    }
  };
  const prompt = (next: "export-path" | "import-path") => {
    typed.current = "";
    setText("");
    setMode(next);
  };
  const loadRows = (next: readonly Row[], nextMode: Mode) => {
    setRows(next);
    select(next.filter(row => row.selectable));
    cursorTo(0);
    setMode(nextMode);
  };
  const chosenProfile = (): Profile => {
    const chosen = selectedRef.current;
    const isChosen = (block: Row["block"], index: number) => chosen.some(row => row.block === block && row.index === index);
    return {
      ...profile!,
      sources: profile!.sources.filter((_, index) => isChosen("sources", index)),
      skills: profile!.skills.filter((_, index) => isChosen("skills", index)),
      apps: profile!.apps.filter((_, index) => isChosen("apps", index)),
    };
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
          diagnostics.current = [...exported.exclusions, ...exported.warnings];
          loadRows(rowsFromExport(exported), "export-list");
        });
      } else if (input === "i") {
        action.current = "import";
        prompt("import-path");
      } else if (current === "results") {
        const next = moveCursor(cursorRef.current, lines.length, input, key);
        if (next !== undefined) cursorTo(Math.max(0, next));
      }
      return;
    }
    if (current === "export-path" || current === "import-path") {
      if (key.escape) {
        setMode("browse");
        return;
      }
      if (key.return && typed.current.trim()) {
        if (current === "export-path") {
          showLines(profileExportPreview(chosenProfile(), diagnostics.current), "confirm");
        } else void run(async () => {
          const raw = JSON.parse(await readFile(typed.current, "utf8"));
          const imported = await buildProfileImport(raw, operations, apps);
          profileVersion.current = raw.agentDepotVersion;
          if (!mounted.current) return;
          setPlan(imported);
          loadRows(rowsFromPlan(imported), "import-list");
        });
      } else if (key.backspace || key.delete) {
        typed.current = typed.current.slice(0, -1);
        setText(typed.current);
      } else if (input && !key.ctrl && !key.meta) {
        typed.current += input;
        setText(typed.current);
      }
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
            const confirmed = { ...plan!, items: selectedPlanItems(plan!, selectedRef.current) };
            const outcomes = await applyProfileImport(confirmed, operations, apps, true, () => undefined,
              { homeDirectory: environment.homeDirectory, ...environment.installationOptions });
            result = outcomes.map(outcome =>
              `${outcome.status}: ${outcome.item.label}${outcome.detail ? `; ${outcome.detail}` : ""}`);
          }
          if (mounted.current) {
            showLines(result.length ? result : ["Nothing selected; nothing written."], "results");
          }
        });
      }, () => setMode("browse"));
      if (input === "y" || input === "n" || key.escape) return;
      const next = moveCursor(cursorRef.current, lines.length, input, key);
      if (next !== undefined) cursorTo(Math.max(0, next));
      return;
    }
    if (key.escape) {
      setMode("browse");
      return;
    }
    const next = moveCursor(cursorRef.current, rows.length, input, key);
    if (next !== undefined) cursorTo(Math.max(0, next));
    else if (input === " " && rows[cursorRef.current]?.selectable) {
      select(toggleChoice(rows, selectedRef.current, rows[cursorRef.current]!));
    } else if (input === "a") select(selectedRef.current.length ? [] : rows.filter(row => row.selectable));
    else if (key.return) {
      if (current === "export-list") {
        if (!selectedRef.current.length) {
          showLines(["Nothing selected; nothing written."], "results");
        } else prompt("export-path");
      } else void run(async () => {
        // Reuse the CLI's core preview for the exact selected subset, including argv and Source notes.
        const items = selectedPlanItems(plan!, selectedRef.current);
        const preview = await buildProfileImport({
          format: PROFILE_FORMAT, agentDepotVersion: profileVersion.current,
          sources: items.filter(item => item.block === "sources").map(item => item.value),
          skills: items.filter(item => item.block === "skills").map(item => item.value),
          apps: items.filter(item => item.block === "apps").map(item => item.value),
        }, operations, apps);
        if (mounted.current) showLines(preview.preview, "confirm");
      });
    }
  });
  const listing = mode === "export-list" || mode === "import-list";
  const window = computeWindow(listing ? rows.length : lines.length, cursor, height);
  return <Box flexDirection="column">
    <Text bold>Portable user-global Profile · e export · i import</Text>
    {mode === "busy" ? <Text>Loading Profile…</Text> : null}
    {mode.endsWith("-path") ? <Text>Profile path: {text}_</Text> : null}
    {listing ? (["sources", "skills", "apps", "excluded"] as const).map(block => {
      const choices = rows.slice(window.start, window.end).filter(row => row.block === block);
      if (!choices.length) return null;
      return <Box key={block} flexDirection="column">
        <Text bold>{block === "excluded" ? "Excluded" : block[0]!.toUpperCase() + block.slice(1)}</Text>
        {block === "excluded" ? <PreviewLines lines={choices.map(row => `${row.label} (not selectable)`)} /> :
          <ChecklistLines choices={choices} cursor={choices.indexOf(rows[cursor]!)}
            isSelected={row => selected.includes(row)} keyOf={row => `${row.block}:${row.index}`}
            label={row => `${row.label}${row.selectable ? "" : " (not selectable)"}`} />}
      </Box>;
    }) : null}
    {mode === "confirm" ? <PreviewConfirm lines={lines.slice(window.start, window.end)} question="Apply Profile? (y/n) · j/k scroll" /> : null}
    {mode === "results" ? <>
      <PreviewLines lines={lines.slice(window.start, window.end)} />
      <Text>j/k scroll</Text>
    </> : null}
    {window.indicator && (listing || mode === "confirm" || mode === "results") ? <Text>{window.indicator}</Text> : null}
    {listing ? <Text>j/k move · space toggle · a all · Enter preview · Esc cancel</Text> : null}
  </Box>;
}
