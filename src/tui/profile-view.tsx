import { readFile } from "node:fs/promises";
import path from "node:path";
import { Box, Text, useWindowSize } from "ink";
import stringWidth from "string-width";
import { useCallback, useMemo, useRef, useState } from "react";
import { createAppOperations } from "../app-flow.js";
import {
  buildProfileExport, describeProfileExportExclusion, describeProfilePackage, describeProfileReplica, describeProfileSkill,
  profileExportPreview, requireOverwritableProfileExport, SKILL_EXPORT_EXPLANATION, writeProfileExport,
  type ProfileExportDiagnostic, type ProfileExportPlan,
} from "../profile-export.js";
import {
  applyProfileImport, buildProfileImport, type ProfileImportEntry, type ProfileImportPlan,
} from "../profile-import.js";
import { PROFILE_FORMAT, PROFILE_FORMAT_V2, parseProfile } from "../profile.js";
import type { Profile } from "../profile.js";
import { selectionKey } from "../package-model.js";
import type { SourceOperations } from "../sources.js";
import type { TuiEnvironment } from "./environment.js";
import { packageOperationsOf } from "./environment.js";
import {
  DEFAULT_PROFILE_FILE_NAME, exportDestination, fileNameNotice, pathExists, pickerStartDirectory,
  resolveExportFileName, type PickerSelection,
} from "./file-picker-model.js";
import { FilePicker } from "./file-picker.js";
import { useKeys } from "./keys.js";
import { usePreviewGeometry, type PreviewChrome } from "./preview-window.js";
import { answerYesNo, moveCursor, movePreviewCursor, toggleChoice } from "./mode-keys.js";
import { BorderPanel, PagedPreview, PreviewLines, Working } from "./panel-parts.js";
import { clipText, elideMiddle, fitLines, wrapText } from "./text-wrap.js";
import { theme } from "./theme.js";
import { useMirrored, useMounted } from "./view-state.js";
import { computeWindow, useListHeight } from "./window.js";
import { busy, type Busy } from "./working-model.js";

/** Input ownership and the stages of the two Profile workflows. */
type Mode = "browse" | "busy" | "export-list" | "export-folder" | "export-name" | "import-browse" | "import-list" | "confirm" | "detail" | "results";

type ConfirmRequest =
  | { readonly kind: "export"; readonly file: string; readonly overwrite: boolean }
  | { readonly kind: "import"; readonly plan: ProfileImportPlan };

/** A choice keeps its source identity and ordinal even when its group is collapsed or offscreen. */
interface Row {
  readonly id: string;
  readonly block: "sources" | "skills" | "apps" | "packages" | "replicas" | "excluded";
  readonly index: number;
  readonly ordinal?: number;
  readonly label: string;
  readonly selectable: boolean;
  /** Import rows only: how the plan classified the item and the Source it groups under. */
  readonly status?: "add" | "same" | "conflict";
  readonly source?: string;
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

/** A group header, followed by its children while the group is open; an empty group is not shown. */
function section(expanded: ReadonlySet<string>, id: string, label: string, depth: number, children: readonly DisplayRow[]): DisplayRow[] {
  if (!children.length) return [];
  const header: GroupRow = { kind: "group", id, label, depth };
  return expanded.has(id) ? [header, ...children] : [header];
}

function exportDisplayRows(rows: readonly Row[], expanded: ReadonlySet<string>): readonly DisplayRow[] {
  const choices = (block: Row["block"]) => rows.filter(row => row.block === block);
  const group = (id: string, label: string, depth: number, children: readonly DisplayRow[]) =>
    section(expanded, id, label, depth, children);
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

const IMPORT_ADD = "import:add";
const IMPORT_APPS = "import:apps";
const importRepoId = (repo: string) => `import:add:${repo}`;

/** Additions by Source and App recipes, then what is already there, then what conflicts. */
function importDisplayRows(rows: readonly Row[], expanded: ReadonlySet<string>): readonly DisplayRow[] {
  const added = rows.filter(row => row.status === "add");
  const recipes = added.filter(row => row.block === "apps");
  const repos = [...new Set(added.filter(row => row.block !== "apps").map(row => row.source ?? ""))];
  const sources = repos.flatMap(repo => {
    const children = added.filter(row => row.block !== "apps" && (row.source ?? "") === repo);
    return section(expanded, importRepoId(repo), `${repo} (${children.length})`, 1, children);
  });
  const unchanged = rows.filter(row => row.status === "same"), conflicts = rows.filter(row => row.status === "conflict");
  return [
    ...section(expanded, IMPORT_ADD, `To import (${added.length})`, 0,
      [...sources, ...section(expanded, IMPORT_APPS, `App recipes (${recipes.length})`, 1, recipes)]),
    ...section(expanded, "import:same", `Unchanged (${unchanged.length})`, 0, unchanged),
    ...section(expanded, "import:conflict", `Conflicts (${conflicts.length}) — not selectable`, 0, conflicts),
  ];
}

/** Additions and conflicts are open to read; the unchanged items are what the person already has. */
function importOpenGroups(rows: readonly Row[]): ReadonlySet<string> {
  const repos = rows.filter(row => row.status === "add" && row.block !== "apps").map(row => importRepoId(row.source ?? ""));
  return new Set([IMPORT_ADD, IMPORT_APPS, "import:conflict", ...repos]);
}

interface PhysicalListWindow {
  readonly start: number;
  readonly end: number;
  readonly indicator: string | undefined;
  readonly stickyGroup: boolean;
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
/** An error naming a long path keeps its first and last rows, where the path starts and the reason ends. */
const NAME_ERROR_ROWS = 3;
const NAME_HINT = "Type to edit · Ctrl+U clear · Enter continue · Esc back to folder";
const NOTE_CHROME: PreviewChrome = { title: "Export note", cancel: "[Esc] close" };

/**
 * A `Label: value` line of the export name stage, wrapped to the panel and kept within `rows` rows. The
 * end of a path (its last folder, the file name) and the end of the typed name (where the cursor is) are
 * what matter, so with fewer than three rows the field keeps its label and its tail behind a `…`; with
 * three or more a path keeps its first row too, around a count of the rows left out.
 */
function NameField({ label, value, rows, width, tail = false }: {
  readonly label: string;
  readonly value: string;
  readonly rows: number;
  readonly width: number;
  readonly tail?: boolean;
}) {
  const wrapped = wrapText(`${label}${value}`, width);
  const cut = wrapped.length > rows;
  const keepsMiddleCount = cut && !tail && rows > 2;
  let shown = wrapped;
  if (keepsMiddleCount) shown = elideMiddle(wrapped, rows, width);
  else if (cut) {
    const characters = Array.from(value);
    for (let dropped = 1; dropped <= characters.length; dropped += 1) {
      shown = wrapText(`${label}…${characters.slice(dropped).join("")}`, width);
      if (shown.length <= rows) break;
    }
  }
  return <>{shown.map((line, index) => {
    if (index === 0 && line.startsWith(label)) {
      return <Text key={index}><Text color={theme.field}>{label}</Text><Text color={theme.value}>{line.slice(label.length)}</Text></Text>;
    }
    return <Text key={index} color={keepsMiddleCount && index === 1 ? theme.muted : theme.value}>{line}</Text>;
  })}</>;
}

function planEntries(plan: ProfileImportPlan): readonly ProfileImportEntry[] {
  return [...plan.items, ...plan.packages];
}

function rowsFromPlan(plan: ProfileImportPlan): readonly Row[] {
  return planEntries(plan).map((item, index): Row => ({
    id: `${item.block}:${index}`, block: item.block, index, ordinal: index + 1,
    label: item.summary, status: item.status, ...(item.group === undefined ? {} : { source: item.group }),
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

/** The rows a list stage shows: the grouped export or import tree, otherwise the flat rows. */
function listRows(mode: Mode, rows: readonly Row[], expanded: ReadonlySet<string>): readonly DisplayRow[] {
  if (mode === "export-list") return exportDisplayRows(rows, expanded);
  return mode === "import-list" ? importDisplayRows(rows, expanded) : rows;
}

/** Collect choices, display shared-core previews and confirm portable Profile transfers. */
export function ProfileView({ operations, environment = {}, onCapturingChange, listHeight, existsCheck = pathExists }: {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  readonly onCapturingChange?: (value: boolean) => void;
  readonly listHeight?: number;
  readonly existsCheck?: (target: string) => Promise<boolean>;
}) {
  const apps = useMemo(() => createAppOperations({
    homeDirectory: environment.homeDirectory, ...environment.appEnvironment,
  }), [environment]);
  const packages = useMemo(() => packageOperationsOf(environment), [environment]);
  const startDirectory = useMemo(() => pickerStartDirectory(environment), [environment]);
  const mounted = useMounted();
  const [mode, modeRef, setModeState] = useMirrored<Mode>("browse");
  const setMode = useCallback((next: Mode) => {
    onCapturingChange?.(next !== "browse" && next !== "results");
    setModeState(next);
  }, [onCapturingChange, setModeState]);
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [expandedGroups, expandedGroupsRef, setExpandedGroups] = useMirrored<ReadonlySet<string>>(new Set());
  const [selected, selectedRef, select] = useMirrored<readonly Row[]>([]);
  const [cursor, cursorRef, cursorTo] = useMirrored(0);
  const [text, typed, setText] = useMirrored("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  // What the busy mode is doing, and when the name check of the export file began, if one is running.
  const [working, setWorking] = useState<Busy | undefined>(undefined);
  const [nameChecking, setNameChecking] = useState<number | undefined>(undefined);
  const [importNotice, setImportNotice] = useState<string | undefined>(undefined);
  const [exportDirectory, setExportDirectory] = useState<string | undefined>(undefined);
  const [importDirectory, setImportDirectory] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<readonly string[]>([]);
  const detailReturnId = useRef<string | undefined>(undefined);
  const confirmRequest = useRef<ConfirmRequest | undefined>(undefined);
  const nameRequest = useRef(0);
  const importRequest = useRef(0);
  const [profile, setProfile] = useState<Profile>();
  const [plan, setPlan] = useState<ProfileImportPlan>();
  const diagnostics = useRef<readonly ProfileExportDiagnostic[]>([]);
  const { columns: terminalColumns } = useWindowSize();
  const panelWidth = Math.max((terminalColumns || 80) - 4, 1);
  const hintCursorRow = listRows(mode, rows, expandedGroupsRef.current)[cursorRef.current];
  const enterHint = hintCursorRow === undefined ? undefined
    : "kind" in hintCursorRow ? "Enter open"
      : hintCursorRow.block === "excluded" ? "Enter note" : undefined;
  const groupHint = hintCursorRow !== undefined && "kind" in hintCursorRow ? " · ←/→ group" : "";
  // With nothing to choose, a header has no item row to move to, so Enter previews instead of opening it.
  const nothingToImport = !rows.some(row => row.selectable);
  const importEnter = hintCursorRow !== undefined && "kind" in hintCursorRow && !nothingToImport ? "Enter open" : "Enter preview";
  const listingHint = mode === "export-list"
    ? `j/k move${groupHint}${enterHint === undefined ? "" : ` · ${enterHint}`} · space toggle · a all · e export · Esc back to menu`
    : `j/k move${groupHint} · space toggle · a all · ${importEnter} · Esc back to menu`;
  const hintText = `${selected.length} selected · ${listingHint}`;
  const titleRows = Math.max(Math.ceil(stringWidth("Export Profile") / panelWidth), 1);
  const hintRows = Math.max(Math.ceil(stringWidth(hintText) / panelWidth), 1);
  const height = useListHeight(listHeight, 4 + titleRows + hintRows);
  const previewGeometry = usePreviewGeometry();
  const confirmChrome = (): PreviewChrome => {
    const request = confirmRequest.current;
    if (request?.kind !== "export") return { title: "Confirmation", action: "Apply Profile", consequence: "Apply Profile? (y/n)" };
    if (!request.overwrite) return { title: "Confirmation", action: "Save/Export Profile", consequence: "Save/Export Profile? (y/n)" };
    // The full path is on the Destination line; the base name keeps the footer short on narrow terminals.
    const name = path.basename(request.file);
    return { title: "Confirmation", action: `Overwrite ${name}`, consequence: `Overwrite ${name}? (y/n)` };
  };
  const showLines = (next: readonly string[], nextMode: "confirm" | "detail" | "results") => {
    setLines(next);
    cursorTo(0);
    setMode(nextMode);
  };
  const startBusy = (label: string) => {
    setWorking(busy(label));
    setMode("busy");
  };
  const run = async (label: string, work: () => Promise<void>) => {
    startBusy(label);
    try { await work(); }
    catch (error) {
      if (mounted.current) {
        showLines([`Error: ${error instanceof Error ? error.message : String(error)}`], "results");
      }
    }
  };
  const loadRows = (next: readonly Row[], nextMode: Mode) => {
    setRows(next);
    select(next.filter(row => row.selectable));
    const open = nextMode === "import-list" ? importOpenGroups(next) : new Set<string>();
    setExpandedGroups(open);
    const firstChoice = listRows(nextMode, next, open).findIndex(row => !("kind" in row) && row.selectable);
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
  const beginExport = () => {
    if (!hasChosenResource(chosenProfile())) {
      showLines(["Nothing selected; nothing written."], "results");
      return;
    }
    setExportDirectory(undefined);
    setNameError(undefined);
    setMode("export-folder");
  };
  const abandonNameCheck = () => {
    nameRequest.current += 1;
    setNameChecking(undefined);
  };
  const chooseExportDirectory = (directory: string) => {
    abandonNameCheck();
    setExportDirectory(directory);
    setNameError(undefined);
    if (typed.current === "") setText(DEFAULT_PROFILE_FILE_NAME);
    setMode("export-name");
  };
  const submitExportName = () => {
    const outcome = resolveExportFileName(typed.current);
    if (outcome.kind === "invalid") { setNameError(outcome.message); return; }
    const directory = exportDirectory ?? startDirectory;
    const fileName = outcome.fileName;
    const finalPath = exportDestination(directory, fileName);
    const id = ++nameRequest.current;
    // The check never blocks keys, so a line beside the name field shows it is running.
    setNameChecking(Date.now());
    void (async () => {
      let exists: boolean;
      try {
        exists = await existsCheck(finalPath);
        if (exists) await requireOverwritableProfileExport(finalPath);
      }
      catch (error) {
        if (!mounted.current || nameRequest.current !== id || modeRef.current !== "export-name") return;
        setNameChecking(undefined);
        setNameError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (mounted.current && nameRequest.current === id) setNameChecking(undefined);
      const current = resolveExportFileName(typed.current);
      if (!mounted.current || nameRequest.current !== id || modeRef.current !== "export-name") return;
      if (current.kind !== "ok" || current.fileName !== fileName) return;
      confirmRequest.current = { kind: "export", file: finalPath, overwrite: exists };
      setNameError(undefined);
      const destination = exists ? `Destination: ${finalPath} (exists; it will be replaced)` : `Destination: ${finalPath}`;
      showLines([destination, ...profileExportPreview(chosenProfile(), diagnostics.current)], "confirm");
    })();
  };
  const confirmApply = () => {
    const request = confirmRequest.current;
    if (request === undefined) return;
    void run(request.kind === "export" ? "Exporting…" : "Applying import…", async () => {
      let result: readonly string[];
      if (request.kind === "export") {
        await writeProfileExport(request.file, chosenProfile(), { overwrite: request.overwrite });
        result = [`Exported profile to ${request.file}`];
      } else {
        const outcomes = await applyProfileImport(request.plan, operations, apps, true, () => undefined,
          { homeDirectory: environment.homeDirectory, packageOperations: packages, ...environment.installationOptions });
        result = outcomes.map(outcome =>
          `${outcome.status}: ${outcome.item.label}${outcome.detail ? `; ${outcome.detail}` : ""}`);
      }
      if (mounted.current) {
        showLines(result.length ? result : ["Nothing selected; nothing written."], "results");
      }
    });
  };
  const previewImport = () => {
    void run("Preparing import preview…", async () => {
      // Reuse the CLI's core preview for the exact selected subset, including argv and Source notes.
      const entries = selectedPlanEntries(plan!, selectedRef.current);
      const subset = selectedImportProfile(profile!, entries);
      const imported = await buildProfileImport(subset, operations, apps, {}, packages);
      if (!mounted.current) return;
      confirmRequest.current = { kind: "import", plan: imported };
      showLines(imported.preview, "confirm");
    });
  };
  const chooseImportFile = (selection: PickerSelection) => {
    if (selection.kind !== "file") return;
    setImportDirectory(selection.directory);
    const id = ++importRequest.current;
    startBusy("Loading Profile…");
    void (async () => {
      try {
        const importedProfile = parseProfile(JSON.parse(await readFile(selection.file, "utf8")));
        const imported = await buildProfileImport(importedProfile, operations, apps, {}, packages);
        if (!mounted.current || importRequest.current !== id) return;
        setProfile(importedProfile);
        setPlan(imported);
        setImportNotice(undefined);
        loadRows(rowsFromPlan(imported), "import-list");
      } catch (error) {
        if (!mounted.current || importRequest.current !== id) return;
        setImportNotice(`Error: ${error instanceof Error ? error.message : String(error)}`);
        setMode("import-browse");
      }
    })();
  };
  useKeys((input, key) => {
    const current = modeRef.current;
    // The FilePicker owns its keys while it is mounted, and async work ignores every key.
    if (current === "export-folder" || current === "import-browse" || current === "busy") return;
    if (current === "browse" || current === "results") {
      if (input === "e") {
        void run("Loading Profile…", async () => {
          const exported = await buildProfileExport(operations, apps, {
            homeDirectory: environment.homeDirectory, packageOperations: packages,
          });
          if (!mounted.current) return;
          setProfile(exported.profile);
          diagnostics.current = [...exported.exclusions, ...exported.warnings];
          loadRows(rowsFromExport(exported), "export-list");
        });
      } else if (input === "i") {
        setImportNotice(undefined);
        setMode("import-browse");
      } else if (current === "results") {
        const next = moveCursor(cursorRef.current, lines.length, input, key);
        if (next !== undefined) cursorTo(Math.max(0, next));
      }
      return;
    }
    if (current === "export-name") {
      if (key.escape) { abandonNameCheck(); setMode("export-folder"); return; }
      if (key.ctrl && input === "u") { abandonNameCheck(); setText(""); setNameError(undefined); return; }
      if (key.return) { submitExportName(); return; }
      if (key.backspace || key.delete) { abandonNameCheck(); setText(typed.current.slice(0, -1)); setNameError(undefined); return; }
      if (input && !key.ctrl && !key.meta) { abandonNameCheck(); setText(typed.current + input); setNameError(undefined); }
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
      const viewport = previewGeometry(lines, cursorRef.current, NOTE_CHROME);
      const next = movePreviewCursor(cursorRef.current, viewport.total, input, key, viewport.height);
      if (next !== undefined) cursorTo(Math.max(0, next));
      return;
    }
    if (current === "confirm") {
      // The preview cursor counts wrapped rows, not source lines, or a long destination would cap the paging.
      const viewport = previewGeometry(lines, cursorRef.current, confirmChrome());
      const next = movePreviewCursor(cursorRef.current, viewport.total, input, key, viewport.height);
      if (next !== undefined) cursorTo(Math.max(0, next));
      else if (input !== "y" || viewport.reachedEnd) {
        answerYesNo(input, key, confirmApply, () => setMode(confirmRequest.current?.kind === "import" ? "import-list" : "export-name"));
      }
      return;
    }
    if (key.escape) { setMode("browse"); return; }
    // export-list and import-list
    const shownRows = listRows(current, rows, expandedGroupsRef.current);
    const currentRow = shownRows[cursorRef.current];
    const next = moveCursor(cursorRef.current, shownRows.length, input, key);
    if (next !== undefined) { cursorTo(Math.max(0, next)); return; }
    if (input === " ") {
      if (currentRow && !("kind" in currentRow) && currentRow.selectable) select(toggleChoice(rows, selectedRef.current, currentRow));
      return;
    }
    if (input === "a") { select(selectedRef.current.length ? [] : rows.filter(row => row.selectable)); return; }
    if (current === "export-list" && input === "e") { beginExport(); return; }
    if (key.return && current === "import-list" && nothingToImport) { previewImport(); return; }
    if (currentRow && "kind" in currentRow && currentRow.kind === "group") {
      if (key.return || key.rightArrow || key.leftArrow) {
        const open = new Set(expandedGroupsRef.current);
        if (key.return) {
          if (open.has(currentRow.id)) open.delete(currentRow.id);
          else open.add(currentRow.id);
        } else if (key.rightArrow) open.add(currentRow.id);
        else open.delete(currentRow.id);
        setExpandedGroups(open);
      }
      return;
    }
    if (key.return && currentRow && !("kind" in currentRow) && currentRow.block === "excluded") {
      detailReturnId.current = currentRow.id;
      showLines(wrapText(currentRow.label, Math.max((terminalColumns || 80) - 8, 1)), "detail");
      return;
    }
    if (key.return && current === "import-list") { previewImport(); return; }
  });
  const listing = mode === "export-list" || mode === "import-list";
  const displayRows: readonly DisplayRow[] = listRows(mode, rows, expandedGroups);
  const rowHeights = displayRows.map(row => {
    // A group header is one row, so the sticky header the window repeats costs exactly the row it reserves.
    if ("kind" in row) return 1;
    const prefixWidth = row.block === "excluded" ? 2 : stringWidth(`> [ ] ${row.ordinal ?? row.index + 1} `);
    return wrapText(row.label, Math.max(panelWidth - prefixWidth, 1)).length;
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
      remainingRows -= 1;
      return <Text key={row.id} color={theme.group} bold>{prefix}{clipText(row.label, width)}</Text>;
    }
    if (row.block === "excluded") {
      const width = Math.max(panelWidth - stringWidth(marker), 1);
      const label = fitLines(wrapText(row.label, width), remainingRows, width)
        .join(`\n${" ".repeat(stringWidth(marker))}`);
      remainingRows -= label.split("\n").length;
      return <Text key={row.id} color={theme.value}>{marker}{label}</Text>;
    }
    // A row the import never changes has no checkbox: unchanged items rest, conflicts warn.
    const box = row.selectable ? `[${selected.some(choice => choice.id === row.id) ? "x" : " "}]` : "   ";
    const prefix = `${marker}${box} ${row.ordinal ?? row.index + 1} `;
    const width = Math.max(panelWidth - stringWidth(prefix), 1);
    const label = fitLines(wrapText(row.label, width), remainingRows, width)
      .join(`\n${" ".repeat(stringWidth(prefix))}`);
    remainingRows -= label.split("\n").length;
    const color = row.status === "conflict" ? theme.warning : row.status === "same" ? theme.muted : theme.value;
    return <Text key={row.id}><Text color={theme.field}>{prefix}</Text><Text color={color}>{label}</Text></Text>;
  });
  const nameOutcome = resolveExportFileName(text);
  const liveDestination = nameOutcome.kind === "ok"
    ? exportDestination(exportDirectory ?? startDirectory, nameOutcome.fileName) : undefined;
  const nameNote = nameOutcome.kind === "ok" ? fileNameNotice(nameOutcome.fileName) : undefined;
  const extensionNote = nameOutcome.kind === "ok" && nameOutcome.appendedExtension
    ? `A name without an extension is saved as ${nameOutcome.fileName}.` : undefined;
  const textRows = (value: string | undefined) => value === undefined ? 0 : wrapText(value, panelWidth).length;
  const nameErrorLines = nameError === undefined ? [] : wrapText(nameError, panelWidth);
  // Keys type into the name, so the stage cannot scroll; instead each long field keeps its end (and, given
  // three rows or more, its first row) within a share of the terminal. The confirmation pages the full destination.
  const nameFixedRows = 3 + textRows(nameNote) + textRows(extensionNote) + Math.min(nameErrorLines.length, NAME_ERROR_ROWS)
    + (nameChecking === undefined ? 0 : 1) + textRows(NAME_HINT);
  const fieldRows = useListHeight(listHeight, nameFixedRows, 3);
  // Leftover rows go to the paths, which are the long fields, before the typed name.
  const folderRows = Math.floor(fieldRows / 3) + (fieldRows % 3 >= 2 ? 1 : 0);
  const destinationRows = Math.floor(fieldRows / 3) + (fieldRows % 3 >= 1 ? 1 : 0);
  const nameRows = fieldRows - folderRows - destinationRows;
  return <Box flexDirection="column">
    {mode === "export-folder" ? <FilePicker purpose="directory" listHeight={listHeight}
      startDirectory={exportDirectory ?? startDirectory}
      onCancel={() => setMode("export-list")}
      onChoose={selection => { if (selection.kind === "directory") chooseExportDirectory(selection.directory); }} /> : null}
    {mode === "import-browse" ? <FilePicker purpose="file" listHeight={listHeight}
      startDirectory={importDirectory ?? startDirectory} notice={importNotice}
      onCancel={() => setMode("browse")} onChoose={chooseImportFile} /> : null}
    {listing ? <BorderPanel title={mode === "export-list" ? "Export Profile" : "Import Profile"}>
      {listContent}
      <Text color={theme.legend}>{hintText}</Text>
      {window.indicator ? <Text color={theme.muted}>{window.indicator}</Text> : null}
    </BorderPanel> : null}
    {mode === "browse" ? <BorderPanel title="Portable Profile">
      <Text color={theme.legend}>e export · i import</Text>
    </BorderPanel> : null}
    {mode === "busy" && working ? <Working label={working.label} since={working.startedAt} /> : null}
    {mode === "export-name" ? <BorderPanel title="Export file name">
      <NameField label="Folder: " value={exportDirectory ?? startDirectory} rows={folderRows} width={panelWidth} />
      <NameField label="Name: " value={`${text}_`} rows={nameRows} width={panelWidth} tail />
      {liveDestination === undefined ? null : <NameField label="Destination: " value={liveDestination} rows={destinationRows} width={panelWidth} />}
      {nameNote === undefined ? null : <Text color={theme.warning}>{nameNote}</Text>}
      {extensionNote === undefined ? null : <Text color={theme.muted}>{extensionNote}</Text>}
      {nameError === undefined ? null : nameErrorLines.length <= NAME_ERROR_ROWS
        ? <Text color={theme.error}>{nameError}</Text>
        : elideMiddle(nameErrorLines, NAME_ERROR_ROWS, panelWidth).map((line, index) => <Text key={index} color={theme.error}>{line}</Text>)}
      {nameChecking === undefined ? null : <Working label="Checking name…" since={nameChecking} />}
      <Text color={theme.legend}>{NAME_HINT}</Text>
    </BorderPanel> : null}
    {mode === "confirm" ? <PagedPreview chrome={confirmChrome()} lines={lines} viewport={previewGeometry(lines, cursor, confirmChrome())} /> : null}
    {mode === "detail" ? <PagedPreview chrome={NOTE_CHROME} lines={lines} viewport={previewGeometry(lines, cursor, NOTE_CHROME)} /> : null}
    {mode === "results" ? <>
      <PreviewLines lines={lines.slice(window.start, window.end)} />
      <Text>j/k scroll</Text>
    </> : null}
    {window.indicator && mode === "results" ? <Text>{window.indicator}</Text> : null}
  </Box>;
}
