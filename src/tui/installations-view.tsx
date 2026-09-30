import { Box, Text, useInput, type Key } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectHost } from "../project-manifest.js";
import { isValidFixedVersion } from "../skill-install.js";
import type { UserGlobalSkillInventoryEntry } from "../user-global-skill-inventory.js";
import type { SourceOperations } from "../sources.js";
import { HOST_CHOICES, type CatalogFocus } from "./catalog-actions.js";
import { runInstall } from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import {
  defaultAdoptionHosts,
  findAdoptionCandidates,
  loadInstallations,
  prepareAdoption,
  sourceIdOf,
  type InstallationRow,
  type InstallationsData,
} from "./installations.js";
import { BROWSE, type InstallationsMode } from "./installations-mode.js";

export type { CatalogFocus };

export interface InstallationsViewProps {
  readonly operations: SourceOperations;
  readonly environment?: TuiEnvironment;
  /** Reports whether the view is capturing keys, so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** `u` / `i` on a user-global installation reuse the Catalog flows for that Skill. */
  readonly onOpenCatalog?: (focus: CatalogFocus) => void;
}

const NO_ENVIRONMENT: TuiEnvironment = {};

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: InstallationsData };

/** A selectable line: a managed installation or an unmanaged Skill. */
type Item =
  | { readonly kind: "installation"; readonly row: InstallationRow }
  | { readonly kind: "unmanaged"; readonly entry: UserGlobalSkillInventoryEntry };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function itemsOf(data: InstallationsData): readonly Item[] {
  return [
    ...(data.global ?? []).map((row): Item => ({ kind: "installation", row })),
    ...data.project.map((row): Item => ({ kind: "installation", row })),
    ...data.unmanaged.map((entry): Item => ({ kind: "unmanaged", entry })),
  ];
}

function describeRow({ selection, source, policy, installed, adopted, modified }: InstallationRow): string {
  const flags = [adopted ? "[adopted]" : "", modified ? "[modified]" : ""].filter((flag) => flag !== "").join(" ");
  return `${selection.path}  ${source}  ${policy} (installed ${installed})  hosts: ${selection.hosts.join(", ")}${flags === "" ? "" : `  ${flags}`}`;
}

export function InstallationsView({ operations, environment, onCapturingChange, onOpenCatalog }: InstallationsViewProps) {
  const env = environment ?? NO_ENVIRONMENT;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  const [mode, setModeState] = useState<InstallationsMode>(BROWSE);
  // Mirrors the mode synchronously so later keystrokes and the shell never see stale state.
  const modeRef = useRef<InstallationsMode>(BROWSE);
  const mounted = useRef(true);
  const [message, setMessage] = useState<Message | undefined>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setMode = (next: InstallationsMode) => {
    modeRef.current = next;
    onCapturingChange?.(next.kind !== "browse");
    setModeState(next);
  };

  const reload = useCallback(async () => {
    try {
      const data = await loadInstallations(operations, env);
      if (mounted.current) setState({ status: "ready", data });
    } catch (error) {
      if (mounted.current) setState({ status: "error", message: errorText(error) });
    }
  }, [operations, env]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const data = state.status === "ready" ? state.data : undefined;
  const items = data ? itemsOf(data) : [];
  const index = Math.min(selected, Math.max(items.length - 1, 0));

  const cancel = (text: string) => {
    setMessage({ kind: "ok", text });
    setMode(BROWSE);
  };

  const fail = (error: unknown) => {
    if (!mounted.current) return;
    setMessage({ kind: "error", text: errorText(error) });
    setMode(BROWSE);
  };

  const startAdoption = async (entry: UserGlobalSkillInventoryEntry) => {
    setMessage(undefined);
    setMode({ kind: "busy", label: `Looking for a Source Skill named ${entry.name}...` });
    try {
      const candidates = await findAdoptionCandidates(operations, entry);
      if (!mounted.current) return;
      if (candidates.length === 0) {
        setMessage({ kind: "error", text: `No Source Skill named "${entry.name}" exists in the registered Sources, so ${entry.path} cannot be adopted` });
        setMode(BROWSE);
      } else if (candidates.length === 1) {
        setMode({ kind: "host", entry, skill: candidates[0]!, cursor: 0, selected: defaultAdoptionHosts(entry) });
      } else {
        setMode({ kind: "pick", entry, candidates, cursor: 0 });
      }
    } catch (error) {
      fail(error);
    }
  };

  const prepare = async (
    mode: Extract<InstallationsMode, { kind: "version" | "fixed" }>,
    version: Parameters<typeof prepareAdoption>[4]["version"],
  ) => {
    setMode({ kind: "busy", label: `Refreshing source and checking that ${mode.entry.name} matches...` });
    try {
      const adoption = await prepareAdoption(operations, env, mode.entry, mode.skill, { hosts: mode.hosts, version });
      if (!mounted.current) return;
      setMode({ kind: "confirm", entry: mode.entry, skill: mode.skill, adoption });
    } catch (error) {
      fail(error);
    }
  };

  const confirm = async (mode: Extract<InstallationsMode, { kind: "confirm" | "confirm-exposure" }>, exposure: boolean) => {
    setMode({ kind: "busy", label: `Adopting ${mode.entry.name}...` });
    let result: Message;
    try {
      result = { kind: "ok", text: (await runInstall(mode.adoption.prepared, operations, exposure)).join(" ") };
    } catch (error) {
      result = { kind: "error", text: errorText(error) };
    }
    await reload();
    if (!mounted.current) return;
    setMessage(result);
    setMode(BROWSE);
  };

  const handleModeKey = (current: InstallationsMode, input: string, key: Key) => {
    switch (current.kind) {
      case "pick":
        if (key.escape) cancel("Adoption cancelled");
        else if (key.downArrow || input === "j") setMode({ ...current, cursor: Math.min(current.cursor + 1, current.candidates.length - 1) });
        else if (key.upArrow || input === "k") setMode({ ...current, cursor: Math.max(current.cursor - 1, 0) });
        else if (key.return) {
          setMode({ kind: "host", entry: current.entry, skill: current.candidates[current.cursor]!, cursor: 0, selected: defaultAdoptionHosts(current.entry) });
        }
        return;
      case "host": {
        const toggle = (host: ProjectHost) =>
          HOST_CHOICES.filter((candidate) => candidate === host ? !current.selected.includes(candidate) : current.selected.includes(candidate));
        if (key.escape) cancel("Adoption cancelled");
        else if (key.downArrow || input === "j") setMode({ ...current, cursor: Math.min(current.cursor + 1, HOST_CHOICES.length - 1) });
        else if (key.upArrow || input === "k") setMode({ ...current, cursor: Math.max(current.cursor - 1, 0) });
        else if (input === " ") setMode({ ...current, selected: toggle(HOST_CHOICES[current.cursor]!) });
        else if (HOST_CHOICES[Number(input) - 1]) setMode({ ...current, selected: toggle(HOST_CHOICES[Number(input) - 1]!) });
        else if (key.return) {
          if (current.selected.length > 0) setMode({ kind: "version", entry: current.entry, skill: current.skill, hosts: current.selected });
          else setMessage({ kind: "error", text: "Select at least one host" });
        }
        return;
      }
      case "version":
        if (key.escape) cancel("Adoption cancelled");
        else if (input === "1") void prepare(current, { policy: "latest" });
        else if (input === "2") setMode({ ...current, kind: "fixed", value: "" });
        return;
      case "fixed":
        if (key.escape) cancel("Adoption cancelled");
        else if (key.return) {
          if (isValidFixedVersion(current.value)) void prepare(current, { policy: "fixed", version: current.value });
        } else if (key.backspace || key.delete) setMode({ ...current, value: current.value.slice(0, -1) });
        else if (input !== "" && !key.ctrl && !key.meta) setMode({ ...current, value: current.value + input });
        return;
      case "confirm":
        if (!current.adoption.verdict.adoptable) {
          if (key.escape || key.return || input === "n") cancel("Adoption cancelled");
        } else if (input === "y") {
          if (current.adoption.prepared.additionalHostExposure) setMode({ ...current, kind: "confirm-exposure" });
          else void confirm(current, false);
        } else if (input === "n" || key.escape) cancel("Adoption cancelled");
        return;
      case "confirm-exposure":
        if (input === "y") void confirm(current, true);
        else if (input === "n" || key.escape) cancel("Adoption cancelled");
        return;
      default:
        return;
    }
  };

  useInput((input, key) => {
    const current = modeRef.current;
    if (current.kind !== "browse") {
      handleModeKey(current, input, key);
      return;
    }
    if (key.downArrow || input === "j") setSelected(Math.min(index + 1, Math.max(items.length - 1, 0)));
    else if (key.upArrow || input === "k") setSelected(Math.max(index - 1, 0));
    else if (input === "A" || key.return || input === "u" || input === "i") {
      const item = items[index];
      if (!item || !data) return;
      setMessage(undefined);
      if (item.kind === "unmanaged") {
        if (input === "A" || key.return) void startAdoption(item.entry);
        return;
      }
      if (input !== "u" && input !== "i") return;
      if (item.row.scope === "project") {
        setMessage({ kind: "error", text: input === "u" ? "Project uninstall is not supported" : "Project installations are managed with the CLI" });
        return;
      }
      const sourceId = sourceIdOf(item.row.selection, data.sources);
      if (sourceId === undefined) {
        setMessage({ kind: "error", text: "The Source of this installation is no longer registered" });
        return;
      }
      onOpenCatalog?.({ sourceId, path: item.row.selection.path, action: input === "u" ? "uninstall" : "install" });
    }
  });

  if (state.status === "loading") return <Text>Loading installations...</Text>;
  if (state.status === "error") return <Text color="red">Error: {state.message}</Text>;
  const ready = state.data;
  let position = 0;
  const line = (text: string) => {
    const marker = position === index ? "> " : "  ";
    const bold = position === index;
    position += 1;
    return { marker, bold, text };
  };

  return (
    <Box flexDirection="column">
      <Text bold>User-global ({ready.global?.length ?? 0})</Text>
      {ready.global === undefined ? <Text>User-global installations are not supported by the configured operations</Text> : null}
      {ready.global?.length === 0 ? <Text>No installations</Text> : null}
      {(ready.global ?? []).map((row) => {
        const { marker, bold, text } = line(describeRow(row));
        return <Text key={`g:${row.source}:${row.selection.path}`} bold={bold}>{marker}{text}</Text>;
      })}
      <Text bold>Project ({ready.project.length})</Text>
      {ready.projectError === undefined ? null : <Text color="red">Error: {ready.projectError}</Text>}
      {ready.projectError === undefined && ready.project.length === 0 ? <Text>No installations</Text> : null}
      {ready.project.map((row) => {
        const { marker, bold, text } = line(describeRow(row));
        return <Text key={`p:${row.source}:${row.selection.path}`} bold={bold}>{marker}{text}</Text>;
      })}
      <Text bold>Unmanaged user-global ({ready.unmanaged.length})</Text>
      {ready.unmanaged.length === 0 ? <Text>No unmanaged Skills</Text> : null}
      {ready.unmanaged.map((entry) => {
        const { marker, bold, text } = line(`${entry.name}  ${entry.path}`);
        return <Text key={`u:${entry.path}`} bold={bold}>{marker}{text}</Text>;
      })}
      {message ? <Text color={message.kind === "error" ? "red" : "green"}>{message.text}</Text> : null}
      <ModePanel mode={mode} />
    </Box>
  );
}

function ModePanel({ mode }: { readonly mode: InstallationsMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "busy":
      return <Text>{mode.label}</Text>;
    case "pick":
      return (
        <Box flexDirection="column">
          <Text>Adopt {mode.entry.name}: several Source Skills match. j/k move, Enter select, Esc cancel:</Text>
          {mode.candidates.map((skill, position) => (
            <Text key={`${skill.sourceId}:${skill.path}`}>{position === mode.cursor ? "> " : "  "}{skill.path}  {skill.sourceId}</Text>
          ))}
        </Box>
      );
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Adopt {mode.entry.name} as {mode.skill.path}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          {HOST_CHOICES.map((host, position) => (
            <Text key={host}>{position === mode.cursor ? "> " : "  "}[{mode.selected.includes(host) ? "x" : " "}] {position + 1} {host}</Text>
          ))}
        </Box>
      );
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "confirm":
      return mode.adoption.verdict.adoptable ? (
        <Box flexDirection="column">
          {mode.adoption.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          {mode.adoption.prepared.runsExternalCommand ? <Text color="yellow">This install runs an external command (see above).</Text> : null}
          <Text>Adopt {mode.entry.name}? y/n</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="red">{mode.adoption.verdict.reason}</Text>
          <Text>Enter/Esc to go back</Text>
        </Box>
      );
    case "confirm-exposure":
      return (
        <Text color="yellow">
          Adopting {mode.entry.name} adds the missing Host location and exposes it to more hosts; this needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
  }
}
