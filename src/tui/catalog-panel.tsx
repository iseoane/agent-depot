import { Box, Text } from "ink";

import { describeSkills, HOST_CHOICES, SCOPE_CHOICES, type ActionMode } from "./catalog-actions.js";
import { skillKey } from "./catalog-tree.js";
import { hasUnmanagedCopy, type InstalledSkills } from "./catalog-installs.js";
import type { FilterState } from "./catalog-filter.js";
import { describeRow, UNMANAGED_MARKER, type NodeData } from "./catalog-tree.js";
import { isPackageMode, PackagePanel } from "./package-actions.js";
import { HostChecklist, PreviewLines } from "./panel-parts.js";
import { rowStyle } from "./theme.js";
import type { VisibleRow } from "./tree.js";
import { theme } from "./theme.js";

/** Scope and counts, the filter line, and why the list may be empty. */
export function CatalogHeader({ scope, listed, installable, total, filter }: {
  readonly scope: string;
  readonly listed: number;
  readonly installable: number;
  readonly total: number;
  readonly filter: FilterState;
}) {
  return (
    <>
      <Text color={theme.muted}>
        Scope: {scope}  {listed} of {installable}
      </Text>
      {filter.editing || filter.query !== "" ? (
        <Text>Filter: {filter.query}{filter.editing ? "_" : ""}</Text>
      ) : null}
      {total === 0 ? <Text>No skills</Text> : null}
      {total > 0 && installable === 0 ? <Text>All skills are installed</Text> : null}
      {installable > 0 && listed === 0 ? <Text>No matching skills</Text> : null}
    </>
  );
}

/** One line of the Catalog tree: cursor, indent, mark box, label and the ownership markers. */
export function CatalogRowLine({ row, selected, marked, installed }: {
  readonly row: VisibleRow<NodeData>;
  readonly selected: boolean;
  readonly marked: boolean;
  readonly installed: InstalledSkills;
}) {
  const { data } = row.node;
  const isGroup = data.kind === "source" || data.kind === "group";
  const ownedBy = data.kind === "skill" ? data.ownedBy : undefined;
  return (
    <Text {...rowStyle(selected)} color={isGroup ? theme.group : ownedBy === undefined ? undefined : theme.inactive}>
      {selected ? "> " : "  "}{"  ".repeat(row.depth)}{data.kind === "skill" ? marked ? "[x] " : "[ ] " : ""}{describeRow(row)}
      {ownedBy === undefined ? null : <Text color={theme.inactive}>{"  "}provided by the {ownedBy.host} Package {ownedBy.name}</Text>}
      {data.kind === "skill" && hasUnmanagedCopy(data.skill, installed)
        ? <Text color={theme.marker}>{"  "}{UNMANAGED_MARKER}</Text>
        : null}
    </Text>
  );
}

/** The prompt of the install flow; browsing shows nothing. */
export function ActionPanel({ mode }: { readonly mode: ActionMode }) {
  if (isPackageMode(mode)) return <PackagePanel mode={mode} />;
  switch (mode.kind) {
    case "browse":
      return null;
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Install {describeSkills(mode.skills)}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          <HostChecklist choices={HOST_CHOICES} cursor={mode.cursor} selected={mode.selected} />
        </Box>
      );
    case "scope":
      return <Text>Scope: {SCOPE_CHOICES.map((scope, i) => `${i + 1} ${scope}`).join("  ")}  (Esc cancel)</Text>;
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "confirm-install": {
      const ready = mode.items.filter((item) => item.prepared !== undefined);
      const single = mode.items.length === 1;
      return (
        <Box flexDirection="column">
          {mode.items.map(({ skill, prepared, error }) =>
            prepared === undefined ? (
              <Text key={skillKey(skill)} color={theme.error}>Cannot install {skill.name}: {error}</Text>
            ) : (
              <Box key={skillKey(skill)} flexDirection="column">
                {single ? null : <Text color={theme.group}>{skill.name}</Text>}
                <PreviewLines lines={prepared.preview} />
              </Box>
            ))}
          {ready.some((item) => item.prepared?.runsExternalCommand) ? <Text color={theme.warning}>This install runs an external command (see above).</Text> : null}
          <Text>Install {describeSkills(ready.map((item) => item.skill))}? y/n</Text>
        </Box>
      );
    }
    case "confirm-exposure": {
      const names = mode.items.filter((item) => item.prepared?.additionalHostExposure).map((item) => item.skill.name);
      return (
        <Text color={theme.warning}>
          {names.length === 1 ? `An identical ${names[0]} already exists` : `Identical copies of ${names.join(", ")} already exist`}; adding the missing Host location needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    }
    case "busy":
      return <Text>{mode.label}</Text>;
  }
}
