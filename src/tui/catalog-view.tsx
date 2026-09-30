import { Box, Text, useInput } from "ink";
import { useEffect, useReducer, useRef, useState } from "react";

import type { SkillCandidate } from "../skill-discovery.js";
import type { SourceOperations } from "../sources.js";
import { filterReducer, filterSkills, initialFilter } from "./catalog-filter.js";

const DESCRIPTION_LIMIT = 60;

export interface CatalogViewProps {
  readonly operations: SourceOperations;
  /** Source whose skills are listed; when absent the catalog covers all sources. */
  readonly sourceId?: string;
  /** Reports whether the view is capturing keys (filter input), so the shell can suspend global keys. */
  readonly onCapturingChange?: (capturing: boolean) => void;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly skills: readonly SkillCandidate[] };

function truncate(text: string): string {
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 3)}...` : text;
}

export function CatalogView({ operations, sourceId, onCapturingChange }: CatalogViewProps) {
  const [all, setAll] = useState(sourceId === undefined);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  const [filter, dispatch] = useReducer(filterReducer, initialFilter);
  // Mirrors the typed query synchronously so keystrokes delivered in one burst are not lost to stale closures.
  const typed = useRef("");

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

  useEffect(() => {
    onCapturingChange?.(filter.editing);
  }, [filter.editing, onCapturingChange]);

  const skills = state.status === "ready" ? state.skills : [];
  const visible = filterSkills(skills, filter.query);
  const index = Math.min(selected, Math.max(visible.length - 1, 0));

  useInput((input, key) => {
    if (filter.editing) {
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
      typed.current = filter.query;
      dispatch({ type: "open" });
    } else if (key.escape && filter.query !== "") {
      typed.current = "";
      dispatch({ type: "clear" });
    } else if (input === "s" && sourceId !== undefined) setAll((value) => !value);
  });

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
        </Text>
      ))}
    </Box>
  );
}
