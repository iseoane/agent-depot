import { readFile } from "node:fs/promises";
import { Box, Text, useWindowSize } from "ink";
import stringWidth from "string-width";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAppOperations } from "../app-flow.js";
import {
  buildProfileExport, describeProfileExportExclusion, describeProfilePackage, describeProfileReplica, describeProfileSkill,
  profileExportPreview, SKILL_EXPORT_EXPLANATION, writeProfileExport,
  type ProfileExportDiagnostic, type ProfileExportPlan,
} from "../profile-export.js";
import {
  applyProfileImport, buildProfileImport, type ProfileImportEntry, type ProfileImportItem,
  type ProfileImportPackageItem, type ProfileImportPlan,
} from "../profile-import.js";
import { PROFILE_FORMAT, PROFILE_FORMAT_V2, parseProfile } from "../profile.js";
import type { Profile } from "../profile.js";
import { selectionKey } from "../package-model.js";
import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { packageOperationsOf } from "./environment.js";
import { useKeys } from "./keys.js";
import { answerYesNo, moveCursor, movePreviewCursor, toggleChoice } from "./mode-keys.js";
import { BorderPanel, PreviewConfirm, PreviewLines } from "./panel-parts.js";
import { theme } from "./theme.js";
import { computeWindow, useListHeight } from "./window.js";

/** Input ownership and the stages of the two Profile workflows. */
type Mode = "browse" | "busy" | "export-list" | "import-list" | "export-path" | "import-path" | "confirm" | "detail" | "results";

/** A choice keeps its source identity and ordinal even when its group is collapsed or offscreen. */
interface Row {
  readonly id: string;
  readonly block: "sources" | "skills" | "apps" | "packages" | "replicas" | "excluded";
  readonly index: number;
  readonly ordinal?: number;
  readonly label: string;
  readonly selectable: boolean;
}

interface GroupRow {
  readonly kind: "group";
  readonly id: string;
  readonly label: string;
  readonly depth: number;
}
type DisplayRow = Row | GroupRow;

function rowsFromExport(plan: ProfileExportPlan): readonly Row[] {
  return [
    ...plan.profile.sources.map((value, index): Row => ({
      id: `sources:${value.url}`, block: "sources", index, ordinal: index + 1,
      label: value.url, selectable: true,
    })),
    ...plan.profile.skills.map((value, index): Row => ({
      id: `skills:${JSON.stringify([value.source, value.path])}`, block: "skills", index, ordinal: index + 1,
      label: describeProfileSkill(value), selectable: true,
    })),
    ...plan.profile.apps.map((value, index): Row => ({
      id: `apps:${JSON.stringify([value.name, value.platform ?? null])}`, block: "apps", index, ordinal: index + 1,
      label: `App recipe ${value.name} (${value.platform ?? "all platforms"})`, selectable: true,
    })),
    ...plan.profile.packages.map((value, index): Row => ({
      id: `packages:${JSON.stringify(value)}`, block: "packages", index, ordinal: index + 1,
      label: describeProfilePackage(value), selectable: true,
    })),
    ...plan.profile.replicas.map((value, index): Row => ({
      id: `replicas:${JSON.stringify(value)}`, block: "replicas", index, ordinal: index + 1,
      label: describeProfileReplica(value), selectable: true,
    })),
    ...plan.exclusions.map((item, index): Row => ({
      id: `excluded:${index}`, block: "excluded", index, label: describeProfileExportExclusion(item), selectable: false,
    })),
    { id: "skill-export-explanation", block: "excluded", index: -1,
      label: SKILL_EXPORT_EXPLANATION, selectable: false },
    ...plan.warnings.filter(warning => warning.kind === "load").map((warning, index): Row => ({
      id: `warning:${index}`, block: "excluded", index: plan.exclusions.length + index,
      label: warning.message, selectable: false,
    })),
  ];
}

function exportDisplayRows(rows: readonly Row[], expanded: ReadonlySet<string>): readonly DisplayRow[] {
  const choices = (block: Row["block"]) => rows.filter(row => row.block === block);
  const group = (id: string, label: string, depth: number, children: readonly DisplayRow[]): DisplayRow[] => {
    if (!children.length) return [];
    const header: GroupRow = { kind: "group", id, label, depth };
    return expanded.has(id) ? [header, ...children] : [header];
  };
  const sourceChildren = [
    ...group("group:sources", `Source choices (${choices("sources").length})`, 1, choices("sources")),
    ...group("group:skills", `Skills (${choices("skills").length})`, 1, choices("skills")),
    ...group("group:apps", `Apps (${choices("apps").length})`, 1, choices("apps")),
    ...group("group:packages", `Packages (${choices("packages").length})`, 1, choices("packages")),
  ];
  return [
    ...group("group:sources-root", "Sources", 0, sourceChildren),
    ...group("group:replicas", `Installed replicas (${choices("replicas").length})`, 0, choices("replicas")),
    ...group("group:excluded", `Export notes (${choices("excluded").length})`, 0, choices("excluded")),
  ];
}

interface PhysicalListWindow {
  readonly start: number;
  readonly end: number;
  readonly indicator: string | undefined;
  readonly stickyGroup: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapListText(value: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = stringWidth(segment);
    if (line && lineWidth + segmentWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += segment;
    lineWidth += segmentWidth;
  }
  return [...lines, line];
}

function fitListLines(lines: readonly string[], maxRows: number, width: number): readonly string[] {
  if (maxRows <= 0) return [];
  if (lines.length <= maxRows) return lines;
  const visible = lines.slice(0, maxRows);
  let last = "";
  let used = 0;
  for (const { segment } of graphemes.segment(visible[maxRows - 1]!)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > width - 1) break;
    last += segment;
    used += segmentWidth;
  }
  visible[maxRows - 1] = `${last}…`;
  return visible;
}

function physicalListWindow(rows: readonly DisplayRow[], rowHeights: readonly number[], selected: number, height: number): PhysicalListWindow {
  if (!rows.length) return { start: 0, end: 0, indicator: undefined, stickyGroup: false };
  const cursor = Math.min(Math.max(selected, 0), rows.length - 1);
  const build = (budget: number) => {
    let start = cursor;
    let end = cursor + 1;
    let used = rowHeights[cursor] ?? 1;
    while (start > 0 || end < rows.length) {
      const previous = start > 0 ? rowHeights[start - 1] : Infinity;
      const next = end < rows.length ? rowHeights[end] : Infinity;
      if (used + Math.min(previous, next) > budget) break;
      if (previous <= next) {
        start--;
        used += previous;
      } else {
        used += next;
        end++;
      }
    }
    return { start, end };
  };
  let range = build(height);
  const needsStickyGroup = (start: number) => start > 0 && !("kind" in rows[start]!) &&
    (rowHeights[start] ?? 1) < height && rows.slice(0, start).some(row => "kind" in row);
  if (needsStickyGroup(range.start)) range = build(Math.max(height - 1, 1));
  const stickyGroup = needsStickyGroup(range.start);
  const hidden = range.start > 0 || range.end < rows.length;
  return { ...range, indicator: hidden ? `${range.start + 1}–${range.end} of ${rows.length}` : undefined, stickyGroup };
}

/** The four import blocks in one indexed list, so the checklist and the confirmation share positions. */
function planEntries(plan: ProfileImportPlan): readonly ProfileImportEntry[] {
  return [...plan.items, ...plan.packages];
}

function rowsFromPlan(plan: ProfileImportPlan): readonly Row[] {
  return planEntries(plan).map((item, index) => ({
    id: `${item.block}:${index}`, block: item.block, index, ordinal: index + 1,
    label: `${item.status}: ${item.label}${item.difference ? `; ${item.difference}` : ""}`,
    selectable: item.status === "add",
  }));
}

function hasChosenResource(profile: Profile): boolean {
  return profile.sources.length + profile.skills.length + profile.apps.length + profile.packages.length > 0;
}

function selectedPlanEntries(plan: ProfileImportPlan, selected: readonly Row[]): readonly ProfileImportEntry[] {
  return planEntries(plan).filter((item, index) => item.status !== "add" || selected.some(row => row.index === index));
}

function selectedImportProfile(profile: Profile, entries: readonly ProfileImportEntry[]): Profile {
  const sources = profile.sources.filter(value => entries.some(item => item.block === "sources" && item.value.url === value.url));
  const skills = profile.skills.filter(value => entries.some(item => item.block === "skills" &&
    item.value.path === value.path && JSON.stringify(item.value.source) === JSON.stringify(value.source)));
  const apps = profile.apps.filter(value => entries.some(item => item.block === "apps" &&
    item.value.name === value.name && item.value.platform === value.platform));
  const packages = profile.packages.filter(value => entries.some(item => item.block === "packages" &&
    selectionKey(item.value) === selectionKey(value)));
  const replicas = profile.replicas.filter(replica => {
    if (replica.kind === "skill") return skills.some(skill => skill.path === replica.path &&
      JSON.stringify(skill.source) === JSON.stringify(replica.source));
    if (replica.kind === "app") return apps.some(app => app.name === replica.name && app.platform === replica.platform);
    return packages.some(selection => selectionKey(selection) === selectionKey(replica.selection));
  });
  return parseProfile({ ...profile, format: replicas.length ? PROFILE_FORMAT_V2 : PROFILE_FORMAT,
    sources, skills, apps, packages, replicas });
}

/** A plan whose items are the chosen subset, split back into the block the writer consumes. */
function chosenPlan(plan: ProfileImportPlan, selected: readonly Row[]): ProfileImportPlan {
  const entries = selectedPlanEntries(plan, selected);
  return {
    ...plan,
    items: entries.filter((item): item is ProfileImportItem => item.block !== "packages"),
    packages: entries.filter((item): item is ProfileImportPackageItem => item.block === "packages"),
  };
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
  const packages = useMemo(() => packageOperationsOf(environment), [environment]);
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
  const [expandedGroups, setExpandedGroupsState] = useState<ReadonlySet<string>>(new Set());
  const expandedGroupsRef = useRef<ReadonlySet<string>>(new Set());
  const setExpandedGroups = (next: ReadonlySet<string>) => {
    expandedGroupsRef.current = next;
    setExpandedGroupsState(next);
  };
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
  const detailReturnId = useRef<string | undefined>(undefined);
  const [profile, setProfile] = useState<Profile>();
  const [plan, setPlan] = useState<ProfileImportPlan>();
  const diagnostics = useRef<readonly ProfileExportDiagnostic[]>([]);
  const action = useRef<"export" | "import">("export");
  const { columns: terminalColumns } = useWindowSize();
  const panelWidth = Math.max((terminalColumns || 80) - 4, 1);
  const listingHint = mode === "export-list"
    ? "j/k · Enter group/preview · ←/→ group · space · a all · Esc"
    : "j/k move · space toggle · a all · Enter preview · Esc";
  const renderedListingHint = mode === "export-list" ? `${listingHint} · preview shows full text` : listingHint;
  const titleRows = Math.max(Math.ceil(stringWidth("Export Profile") / panelWidth), 1);
  const hintRows = Math.max(Math.ceil(stringWidth(renderedListingHint) / panelWidth), 1);
  const height = useListHeight(listHeight, 4 + titleRows + hintRows);
  const showLines = (next: readonly string[], nextMode: "confirm" | "detail" | "results") => {
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
    const open = new Set<string>();
    setExpandedGroups(open);
    const firstChoice = nextMode === "export-list"
      ? exportDisplayRows(next, open).findIndex(row => !("kind" in row) && row.selectable)
      : 0;
    cursorTo(Math.max(firstChoice, 0));
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
      packages: profile!.packages.filter((_, index) => isChosen("packages", index)),
      replicas: profile!.replicas.filter((replica, index) => {
        if (!isChosen("replicas", index)) return false;
        if (replica.kind === "skill") return profile!.skills.some((skill, skillIndex) =>
          isChosen("skills", skillIndex) && skill.path === replica.path && JSON.stringify(skill.source) === JSON.stringify(replica.source));
        if (replica.kind === "app") return profile!.apps.some((app, appIndex) =>
          isChosen("apps", appIndex) && app.name === replica.name && app.platform === replica.platform);
        return profile!.packages.some((selection, packageIndex) =>
          isChosen("packages", packageIndex) && JSON.stringify(selection) === JSON.stringify(replica.selection));
      }),
    };
  };
  useKeys((input, key) => {
    const current = modeRef.current;
    if (current === "busy") return;
    if (current === "browse" || current === "results") {
      if (input === "e") {
        action.current = "export";
        void run(async () => {
          const exported = await buildProfileExport(operations, apps, {
            homeDirectory: environment.homeDirectory, packageOperations: packages,
          });
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
      if (key.return) {
        if (!typed.current.trim()) return;
        if (current === "export-path") {
          showLines(profileExportPreview(chosenProfile(), diagnostics.current), "confirm");
        } else void run(async () => {
          const importedProfile = parseProfile(JSON.parse(await readFile(typed.current, "utf8")));
          const imported = await buildProfileImport(importedProfile, operations, apps, {}, packages);
          if (!mounted.current) return;
          setProfile(importedProfile);
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
    if (current === "detail") {
      if (key.escape) {
        const returnIndex = exportDisplayRows(rows, expandedGroupsRef.current)
          .findIndex(row => !("kind" in row) && row.id === detailReturnId.current);
        cursorTo(Math.max(returnIndex, 0));
        detailReturnId.current = undefined;
        setMode("export-list");
        return;
      }
      const next = movePreviewCursor(cursorRef.current, lines.length, input, key, height);
      if (next !== undefined) cursorTo(Math.max(0, next));
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
            const confirmed = chosenPlan(plan!, selectedRef.current);
            const outcomes = await applyProfileImport(confirmed, operations, apps, true, () => undefined,
              { homeDirectory: environment.homeDirectory, packageOperations: packages, ...environment.installationOptions });
            result = outcomes.map(outcome =>
              `${outcome.status}: ${outcome.item.label}${outcome.detail ? `; ${outcome.detail}` : ""}`);
          }
          if (mounted.current) {
            showLines(result.length ? result : ["Nothing selected; nothing written."], "results");
          }
        });
      }, () => setMode("browse"));
      if (input === "y" || input === "n" || key.escape) return;
      const next = movePreviewCursor(cursorRef.current, lines.length, input, key, height);
      if (next !== undefined) cursorTo(Math.max(0, next));
      return;
    }
    if (key.escape) {
      setMode("browse");
      return;
    }
    const visibleRows = current === "export-list" ? exportDisplayRows(rows, expandedGroupsRef.current) : rows;
    const currentRow = visibleRows[cursorRef.current];
    const next = moveCursor(cursorRef.current, visibleRows.length, input, key);
    if (next !== undefined) cursorTo(Math.max(0, next));
    else if (current === "export-list" && currentRow && "kind" in currentRow && currentRow.kind === "group" &&
      (key.return || key.rightArrow || key.leftArrow)) {
      if (key.return && !hasChosenResource(chosenProfile())) {
        showLines(["Nothing selected; nothing written."], "results");
        return;
      }
      const open = new Set(expandedGroupsRef.current);
      if (key.return) {
        if (open.has(currentRow.id)) open.delete(currentRow.id);
        else open.add(currentRow.id);
      } else if (key.rightArrow) open.add(currentRow.id);
      else open.delete(currentRow.id);
      setExpandedGroups(open);
    } else if (input === " " && currentRow && !("kind" in currentRow) && currentRow.selectable) {
      select(toggleChoice(rows, selectedRef.current, currentRow));
    } else if (input === "a") select(selectedRef.current.length ? [] : rows.filter(row => row.selectable));
    else if (current === "export-list" && key.return && currentRow && !("kind" in currentRow) && currentRow.block === "excluded") {
      detailReturnId.current = currentRow.id;
      showLines(wrapListText(currentRow.label, Math.max((terminalColumns || 80) - 8, 1)), "detail");
    } else if (key.return) {
      if (current === "export-list") {
        if (!hasChosenResource(chosenProfile())) {
          showLines(["Nothing selected; nothing written."], "results");
        } else prompt("export-path");
      } else void run(async () => {
        // Reuse the CLI's core preview for the exact selected subset, including argv and Source notes.
        const entries = selectedPlanEntries(plan!, selectedRef.current);
        const subset = selectedImportProfile(profile!, entries);
        const preview = await buildProfileImport(subset, operations, apps, {}, packages);
        if (mounted.current) showLines(preview.preview, "confirm");
      });
    }
  });
  const listing = mode === "export-list" || mode === "import-list";
  const displayRows: readonly DisplayRow[] = mode === "export-list" ? exportDisplayRows(rows, expandedGroups) : rows;
  const rowHeights = displayRows.map(row => {
    const prefixWidth = "kind" in row ? stringWidth(`> ${" ".repeat(row.depth * 2)}▸ `) : row.block === "excluded" ? 2
      : stringWidth(`> [ ] ${row.ordinal ?? row.index + 1} `);
    const label = !("kind" in row) && row.block !== "excluded" && !row.selectable
      ? `${row.label} (not selectable)` : row.label;
    return wrapListText(label, Math.max(panelWidth - prefixWidth, 1)).length;
  });
  const listWindow = physicalListWindow(displayRows, rowHeights, cursor, height);
  const window = listing ? listWindow : computeWindow(lines.length, cursor, height);
  const visibleRows = displayRows.slice(window.start, window.end);
  const precedingGroup = displayRows.slice(0, window.start).filter((row): row is GroupRow => "kind" in row).at(-1);
  const indexedRows = visibleRows.map((row, index) => ({ row, index: window.start + index }));
  const renderedRows = listWindow.stickyGroup && precedingGroup
    ? [{ row: precedingGroup, index: undefined }, ...indexedRows]
    : indexedRows;
  let remainingRows = height;
  const listContent = renderedRows.map(({ row, index }) => {
    const marker = index === cursor ? "> " : "  ";
    if ("kind" in row) {
      const open = expandedGroups.has(row.id);
      const prefix = `${marker}${" ".repeat(row.depth * 2)}${open ? "▾" : "▸"} `;
      const width = Math.max(panelWidth - stringWidth(prefix), 1);
      const label = fitListLines(wrapListText(row.label, width), remainingRows, width)
        .join(`\n${" ".repeat(stringWidth(prefix))}`);
      remainingRows -= label.split("\n").length;
      return <Text key={row.id} color={theme.group} bold>{prefix}{label}</Text>;
    }
    if (row.block === "excluded") {
      const width = Math.max(panelWidth - stringWidth(marker), 1);
      const label = fitListLines(wrapListText(row.label, width), remainingRows, width)
        .join(`\n${" ".repeat(stringWidth(marker))}`);
      remainingRows -= label.split("\n").length;
      return <Text key={row.id} color={theme.value}>{marker}{label}</Text>;
    }
    const prefix = `${marker}[${selected.some(choice => choice.id === row.id) ? "x" : " "}] ${row.ordinal ?? row.index + 1} `;
    const value = `${row.label}${row.selectable ? "" : " (not selectable)"}`;
    const width = Math.max(panelWidth - stringWidth(prefix), 1);
    const label = fitListLines(wrapListText(value, width), remainingRows, width)
      .join(`\n${" ".repeat(stringWidth(prefix))}`);
    remainingRows -= label.split("\n").length;
    return <Text key={row.id}><Text color={theme.field}>{prefix}</Text><Text color={theme.value}>{label}</Text></Text>;
  });
  return <Box flexDirection="column">
    {listing ? <BorderPanel title={mode === "export-list" ? "Export Profile" : "Import Profile"}>
      {listContent}
      <Text color={theme.legend}>{renderedListingHint}</Text>
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
    </BorderPanel> : null}
    {mode !== "confirm" && mode !== "detail" && !listing ? <BorderPanel title="Portable Profile">
      <Text color={theme.legend}>e export · i import</Text>
    </BorderPanel> : null}
    {mode === "busy" ? <Text>Loading Profile…</Text> : null}
    {mode.endsWith("-path") ? <Text>Profile path: {text}_</Text> : null}
    {mode === "confirm" ? <PreviewConfirm lines={lines} cursor={cursor} question="Apply Profile? (y/n) · arrows/PgUp/PgDn page · j/k line" /> : null}
    {mode === "detail" ? <PreviewConfirm title="Export note" lines={lines} cursor={cursor}
      question="Esc close · arrows/PgUp/PgDn page · j/k line" /> : null}
    {mode === "results" ? <>
      <PreviewLines lines={lines.slice(window.start, window.end)} />
      <Text>j/k scroll</Text>
    </> : null}
    {window.indicator && mode === "results" ? <Text>{window.indicator}</Text> : null}
  </Box>;
}
