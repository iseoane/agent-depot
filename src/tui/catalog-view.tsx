import { Box, Text, useInput, type Key } from "ink";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { SkillCandidate } from "../skill-discovery.js";
import type { SourceOperations } from "../sources.js";
import { BROWSE, HOST_CHOICES, SCOPE_CHOICES, type ActionMode, type CatalogFocus } from "./catalog-actions.js";
import { filterReducer, filterSkills, initialFilter, type FilterEvent, type FilterState } from "./catalog-filter.js";
import {
  globalRecord,
  installMarker,
  loadInstalledSkills,
  missingHosts,
  NO_INSTALLED,
  prepareHostAddition,
  prepareHostRemoval,
  prepareInstall,
  prepareUninstall,
  runHostAddition,
  runHostRemoval,
  runInstall,
  runUninstall,
  type InstalledSkills,
} from "./catalog-installs.js";
import type { TuiEnvironment } from "./environment.js";
import type { ProjectHost } from "../project-manifest.js";
import { isValidFixedVersion } from "../skill-install.js";

const DESCRIPTION_LIMIT = 60;
const NO_ENVIRONMENT: TuiEnvironment = {};

export interface CatalogViewProps {
  readonly operations: SourceOperations;
  /** Source whose skills are listed; when absent the catalog covers all sources. */
  readonly sourceId?: string;
  /** Reports whether the view is capturing keys (filter input), so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
  /** Where installs and uninstalls happen; defaults to the real home and working directory. */
  readonly environment?: TuiEnvironment;
  /** Highlights a Skill and starts its `u` / `i` flow once, e.g. when opened from the Installations view. */
  readonly focus?: CatalogFocus;
}

interface Message {
  readonly kind: "ok" | "error";
  readonly text: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly skills: readonly SkillCandidate[] };

function truncate(text: string): string {
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 3)}...` : text;
}

export function CatalogView({ operations, sourceId, onCapturingChange, environment, focus }: CatalogViewProps) {
  const [all, setAll] = useState(sourceId === undefined);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  const [filter, dispatchFilter] = useReducer(filterReducer, initialFilter);
  // Mirrors the filter synchronously so the shell never sees a stale capturing state.
  const filterRef = useRef<FilterState>(initialFilter);
  // Mirrors the typed query synchronously so keystrokes delivered in one burst are not lost to stale closures.
  const typed = useRef("");
  const [installed, setInstalled] = useState<InstalledSkills>(NO_INSTALLED);
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [action, setActionState] = useState<ActionMode>(BROWSE);
  // Mirrors the action mode synchronously, like the filter, so later keystrokes and the shell never see stale state.
  const actionRef = useRef<ActionMode>(BROWSE);
  const mounted = useRef(true);
  const [message, setMessage] = useState<Message | undefined>();
  const env = environment ?? NO_ENVIRONMENT;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reloadInstalled = useCallback(async () => {
    const loaded = await loadInstalledSkills(operations, env);
    if (mounted.current) {
      setInstalled(loaded);
      setInstalledLoaded(true);
    }
  }, [operations, env]);

  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

  const setAction = (next: ActionMode) => {
    actionRef.current = next;
    onCapturingChange?.(filterRef.current.editing || next.kind !== "browse");
    setActionState(next);
  };

  useEffect(() => {
    let cancelled = false;
    const discover = operations.discoverSkills;
    if (!discover) {
      setState({ status: "error", message: "Discovery is not supported by the configured operations" });
      return;
    }
    setState({ status: "loading" });
    setSelected(0);
    void (async () => {
      try {
        const ids = all || sourceId === undefined
          ? (await operations.listSources()).map((source) => source.id)
          : [sourceId];
        const skills = await discover(ids);
        if (!cancelled) setState({ status: "ready", skills });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [operations, sourceId, all]);

  const dispatch = (event: FilterEvent) => {
    filterRef.current = filterReducer(filterRef.current, event);
    onCapturingChange?.(filterRef.current.editing || actionRef.current.kind !== "browse");
    dispatchFilter(event);
  };

  const skills = state.status === "ready" ? state.skills : [];
  const visible = filterSkills(skills, filter.query);
  const index = Math.min(selected, Math.max(visible.length - 1, 0));

  const startInstall = async (
    skill: SkillCandidate,
    choice: Parameters<typeof prepareInstall>[3],
  ) => {
    setAction({ kind: "busy", label: `Refreshing source and preparing install of ${skill.name}...` });
    try {
      const prepared = await prepareInstall(operations, env, skill, choice);
      if (!mounted.current) return;
      setAction({ kind: "confirm-install", skill, prepared });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", text: errorText(error) });
      setAction(BROWSE);
    }
  };

  /** `u`: one host goes straight to full removal; several ask whether to remove all or choose. */
  const startUninstall = (skill: SkillCandidate) => {
    const record = globalRecord(skill, installed);
    if (record && record.hosts.length > 1) setAction({ kind: "remove-scope", skill, hosts: record.hosts });
    else void startFullUninstall(skill);
  };

  const startFullUninstall = async (skill: SkillCandidate) => {
    setAction({ kind: "busy", label: `Preparing uninstall of ${skill.name}...` });
    try {
      const prepared = await prepareUninstall(operations, env, skill, installed);
      if (!mounted.current) return;
      if (prepared.kind === "ready") {
        setAction({ kind: "confirm-uninstall", skill, prepared });
        return;
      }
      setMessage({ kind: "error", text: UNINSTALL_REFUSALS[prepared.kind] });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", text: errorText(error) });
    }
    setAction(BROWSE);
  };

  /** Reloads the markers first so the result and the markers appear together. */
  const finish = async (result: Message) => {
    await reloadInstalled();
    if (!mounted.current) return;
    setMessage(result);
    setAction(BROWSE);
  };

  const confirmInstall = async (mode: Extract<ActionMode, { kind: "confirm-install" | "confirm-exposure" }>, exposure: boolean) => {
    setAction({ kind: "busy", label: `Installing ${mode.skill.name}...` });
    let result: Message;
    try {
      result = { kind: "ok", text: (await runInstall(mode.prepared, operations, exposure)).join(" ") };
    } catch (error) {
      result = { kind: "error", text: errorText(error) };
    }
    await finish(result);
  };

  const confirmUninstall = async (mode: Extract<ActionMode, { kind: "confirm-uninstall" }>) => {
    setAction({ kind: "busy", label: `Removing ${mode.skill.name}...` });
    let result: Message;
    try {
      await runUninstall(mode.prepared, operations, env);
      result = { kind: "ok", text: `Removed ${mode.skill.name} (${mode.skill.path})` };
    } catch (error) {
      result = { kind: "error", text: errorText(error) };
    }
    await finish(result);
  };

  const startHostChange = async (
    mode: Extract<ActionMode, { kind: "hosts-add" | "hosts-remove" }>,
  ) => {
    const adding = mode.kind === "hosts-add";
    setAction({ kind: "busy", label: `Preparing host change of ${mode.skill.name}...` });
    try {
      if (adding) {
        const prepared = await prepareHostAddition(operations, env, mode.skill, installed, mode.selected);
        if (!mounted.current) return;
        setAction({ kind: "confirm-host-add", skill: mode.skill, prepared });
      } else {
        const prepared = await prepareHostRemoval(operations, env, mode.skill, installed, mode.selected);
        if (!mounted.current) return;
        setAction({ kind: "confirm-host-remove", skill: mode.skill, prepared });
      }
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ kind: "error", text: errorText(error) });
      setAction(BROWSE);
    }
  };

  const confirmHostChange = async (
    mode: Extract<ActionMode, { kind: "confirm-host-exposure" | "confirm-host-remove" }>,
  ) => {
    setAction({ kind: "busy", label: `Changing hosts of ${mode.skill.name}...` });
    let result: Message;
    try {
      const text = mode.kind === "confirm-host-exposure"
        ? await runHostAddition(mode.prepared, operations, env)
        : await runHostRemoval(mode.prepared, operations, env, mode.skill);
      result = { kind: "ok", text };
    } catch (error) {
      result = { kind: "error", text: errorText(error) };
    }
    await finish(result);
  };

  const cancel = (text: string) => {
    setMessage({ kind: "ok", text });
    setAction(BROWSE);
  };

  const handleActionKey = (mode: ActionMode, input: string, key: Key) => {
    switch (mode.kind) {
      case "host": {
        const toggle = (host: ProjectHost) =>
          HOST_CHOICES.filter((candidate) => candidate === host ? !mode.selected.includes(candidate) : mode.selected.includes(candidate));
        if (key.escape) cancel("Install cancelled");
        else if (key.downArrow || input === "j") setAction({ ...mode, cursor: Math.min(mode.cursor + 1, HOST_CHOICES.length - 1) });
        else if (key.upArrow || input === "k") setAction({ ...mode, cursor: Math.max(mode.cursor - 1, 0) });
        else if (input === " ") setAction({ ...mode, selected: toggle(HOST_CHOICES[mode.cursor]!) });
        else if (HOST_CHOICES[Number(input) - 1]) setAction({ ...mode, selected: toggle(HOST_CHOICES[Number(input) - 1]!) });
        else if (key.return) {
          if (mode.selected.length > 0) setAction({ kind: "scope", skill: mode.skill, hosts: mode.selected });
          else setMessage({ kind: "error", text: "Select at least one host" });
        }
        return;
      }
      case "installed-choice":
        if (key.escape) cancel("Install cancelled");
        else if (input === "1") {
          setAction({ kind: "hosts-add", skill: mode.skill, choices: mode.missing, cursor: 0, selected: [] });
        } else if (input === "2") setAction({ kind: "host", skill: mode.skill, cursor: 0, selected: [] });
        return;
      case "remove-scope":
        if (key.escape) cancel("Uninstall cancelled");
        else if (input === "1") void startFullUninstall(mode.skill);
        else if (input === "2") {
          setAction({ kind: "hosts-remove", skill: mode.skill, choices: mode.hosts, cursor: 0, selected: [] });
        }
        return;
      case "hosts-add":
      case "hosts-remove": {
        const toggle = (host: ProjectHost) =>
          mode.choices.filter((candidate) => candidate === host ? !mode.selected.includes(candidate) : mode.selected.includes(candidate));
        const numbered = mode.choices[Number(input) - 1];
        if (key.escape) cancel(mode.kind === "hosts-add" ? "Install cancelled" : "Uninstall cancelled");
        else if (key.downArrow || input === "j") setAction({ ...mode, cursor: Math.min(mode.cursor + 1, mode.choices.length - 1) });
        else if (key.upArrow || input === "k") setAction({ ...mode, cursor: Math.max(mode.cursor - 1, 0) });
        else if (input === " ") setAction({ ...mode, selected: toggle(mode.choices[mode.cursor]!) });
        else if (numbered) setAction({ ...mode, selected: toggle(numbered) });
        else if (key.return) {
          if (mode.selected.length > 0) void startHostChange(mode);
          else setMessage({ kind: "error", text: "Select at least one host" });
        }
        return;
      }
      case "confirm-host-add":
        if (input === "y") setAction({ ...mode, kind: "confirm-host-exposure" });
        else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      case "confirm-host-exposure":
        if (input === "y") void confirmHostChange(mode);
        else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      case "confirm-host-remove":
        if (input === "y") void confirmHostChange(mode);
        else if (input === "n" || key.escape) cancel("Uninstall cancelled");
        return;
      case "scope": {
        const scope = SCOPE_CHOICES[Number(input) - 1];
        if (key.escape) cancel("Install cancelled");
        else if (scope) setAction({ kind: "version", skill: mode.skill, hosts: mode.hosts, scope });
        return;
      }
      case "version":
        if (key.escape) cancel("Install cancelled");
        else if (input === "1") void startInstall(mode.skill, { hosts: mode.hosts, scope: mode.scope, version: { policy: "latest" } });
        else if (input === "2") setAction({ ...mode, kind: "fixed", value: "" });
        return;
      case "fixed":
        if (key.escape) cancel("Install cancelled");
        else if (key.return) {
          if (isValidFixedVersion(mode.value)) {
            void startInstall(mode.skill, { hosts: mode.hosts, scope: mode.scope, version: { policy: "fixed", version: mode.value } });
          }
        } else if (key.backspace || key.delete) setAction({ ...mode, value: mode.value.slice(0, -1) });
        else if (input !== "" && !key.ctrl && !key.meta) setAction({ ...mode, value: mode.value + input });
        return;
      case "confirm-install":
        if (input === "y") {
          if (mode.prepared.additionalHostExposure) setAction({ ...mode, kind: "confirm-exposure" });
          else void confirmInstall(mode, false);
        } else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      case "confirm-exposure":
        if (input === "y") void confirmInstall(mode, true);
        else if (input === "n" || key.escape) cancel("Install cancelled");
        return;
      case "confirm-uninstall":
        if (input === "y") void confirmUninstall(mode);
        else if (input === "n" || key.escape) cancel("Uninstall cancelled");
        return;
      default:
        return;
    }
  };

  useInput((input, key) => {
    const mode = actionRef.current;
    if (mode.kind !== "browse") {
      handleActionKey(mode, input, key);
      return;
    }
    const current = filterRef.current;
    if (current.editing) {
      if (key.escape) {
        typed.current = "";
        setSelected(0);
        dispatch({ type: "clear" });
      } else if (key.return) dispatch({ type: "keep" });
      else if (key.backspace || key.delete) {
        typed.current = typed.current.slice(0, -1);
        setSelected(0);
        dispatch({ type: "edit", query: typed.current });
      } else if (input !== "" && !key.ctrl && !key.meta) {
        typed.current += input;
        setSelected(0);
        dispatch({ type: "edit", query: typed.current });
      }
      return;
    }
    if (key.downArrow || input === "j") setSelected(Math.min(index + 1, Math.max(visible.length - 1, 0)));
    else if (key.upArrow || input === "k") setSelected(Math.max(index - 1, 0));
    else if (input === "/") {
      typed.current = current.query;
      dispatch({ type: "open" });
    } else if (key.escape && current.query !== "") {
      typed.current = "";
      dispatch({ type: "clear" });
    } else if (input === "s" && sourceId !== undefined) setAll((value) => !value);
    else if ((input === "i" || input === "u") && state.status === "ready") {
      const skill = visible[index];
      if (!skill) return;
      setMessage(undefined);
      startAction(skill, input === "u" ? "uninstall" : "install");
    }
  });

  /** `u` / `i` on a Skill; also used to start the flow requested through `focus`. */
  function startAction(skill: SkillCandidate, kind: CatalogFocus["action"]) {
    if (kind === "uninstall") startUninstall(skill);
    else {
      const record = globalRecord(skill, installed);
      const missing = record ? missingHosts(record) : [];
      if (record && missing.length > 0) setAction({ kind: "installed-choice", skill, missing });
      else setAction({ kind: "host", skill, cursor: 0, selected: [] });
    }
  }

  // Runs the requested flow once, after both the Skills and the installation records are loaded.
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || focused.current || state.status !== "ready" || !installedLoaded) return;
    focused.current = true;
    const position = state.skills.findIndex((skill) => skill.sourceId === focus.sourceId && skill.path === focus.path);
    const skill = state.skills[position];
    if (!skill) {
      setMessage({ kind: "error", text: `Skill ${focus.path} was not found in ${focus.sourceId}` });
      return;
    }
    setSelected(position);
    startAction(skill, focus.action);
  }, [focus, state, installedLoaded]);

  const scope = all || sourceId === undefined ? "all sources" : sourceId;
  if (state.status === "loading") return <Text>Loading skills...</Text>;
  if (state.status === "error") return <Text color="red">Error: {state.message}</Text>;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Scope: {scope}  {visible.length} of {skills.length}
      </Text>
      {filter.editing || filter.query !== "" ? (
        <Text>Filter: {filter.query}{filter.editing ? "_" : ""}</Text>
      ) : null}
      {skills.length === 0 ? <Text>No skills</Text> : null}
      {skills.length > 0 && visible.length === 0 ? <Text>No matching skills</Text> : null}
      {visible.map((skill, position) => (
        <Text key={`${skill.sourceId}:${skill.path}`} bold={position === index}>
          {position === index ? "> " : "  "}
          {skill.name}  {truncate(skill.description)}  {skill.sourceId}
          {installMarker(skill, installed) === "" ? "" : `  ${installMarker(skill, installed)}`}
        </Text>
      ))}
      {message ? <Text color={message.kind === "error" ? "red" : "green"}>{message.text}</Text> : null}
      <ActionPanel mode={action} />
    </Box>
  );
}

const UNINSTALL_REFUSALS = {
  unsupported: "Uninstall is not supported by the configured operations",
  "not-installed": "Skill is not installed",
  "project-only": "Project uninstall is not supported",
} as const;

function ActionPanel({ mode }: { readonly mode: ActionMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Install {mode.skill.name}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          {HOST_CHOICES.map((host, position) => (
            <Text key={host}>
              {position === mode.cursor ? "> " : "  "}[{mode.selected.includes(host) ? "x" : " "}] {position + 1} {host}
            </Text>
          ))}
        </Box>
      );
    case "installed-choice":
      return (
        <Text>
          {mode.skill.name} is installed user-global. 1 add hosts ({mode.missing.join(", ")})  2 new install (project or other scope)  (Esc cancel)
        </Text>
      );
    case "remove-scope":
      return <Text>Uninstall {mode.skill.name} (hosts: {mode.hosts.join(", ")}): 1 all hosts  2 choose hosts  (Esc cancel)</Text>;
    case "hosts-add":
    case "hosts-remove":
      return (
        <Box flexDirection="column">
          <Text>
            {mode.kind === "hosts-add" ? "Add hosts to" : "Remove hosts from"} {mode.skill.name}. Host (space/1-{mode.choices.length} toggle, j/k move, Enter continue, Esc cancel):
          </Text>
          {mode.choices.map((host, position) => (
            <Text key={host}>
              {position === mode.cursor ? "> " : "  "}[{mode.selected.includes(host) ? "x" : " "}] {position + 1} {host}
            </Text>
          ))}
        </Box>
      );
    case "confirm-host-add":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          <Text>Add hosts to {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "confirm-host-exposure":
      return (
        <Text color="yellow">
          Adding hosts exposes the installed {mode.skill.name} to more hosts and needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    case "confirm-host-remove":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          <Text>Remove hosts from {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "scope":
      return <Text>Scope: {SCOPE_CHOICES.map((scope, i) => `${i + 1} ${scope}`).join("  ")}  (Esc cancel)</Text>;
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "busy":
      return <Text>{mode.label}</Text>;
    case "confirm-install":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          {mode.prepared.runsExternalCommand ? <Text color="yellow">This install runs an external command (see above).</Text> : null}
          <Text>Install {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "confirm-exposure":
      return (
        <Text color="yellow">
          An identical {mode.skill.name} already exists; adding the missing Host location needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    case "confirm-uninstall":
      return (
        <Box flexDirection="column">
          {mode.prepared.plan.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          <Text>Uninstall {mode.skill.name}? y/n</Text>
        </Box>
      );
  }
}
