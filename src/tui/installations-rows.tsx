import { Text } from "ink";

import { describeLinks, describeNode, markersOf, type NodeData } from "./installations-tree.js";
import { rowStyle, theme } from "./theme.js";
import type { VisibleRow } from "./tree.js";
import type { AppRow } from "./installations.js";
import type { PackageRow } from "./package-rows.js";

function AppDetails({ row }: { readonly row: AppRow }) {
  const version = row.inspection.installedVersion;
  const statusColor = row.inspection.status === "invalid" ? theme.error : theme.warning;
  const invalid = row.inspection.status === "invalid" ? ` · invalid recipe: ${row.inspection.reason ?? "unknown error"}` : "";
  return (
    <Text><Text color={theme.legend}>  </Text><Text color={version === undefined ? statusColor : theme.version}>{version ?? row.inspection.status}</Text>
      {row.inspection.evidence === "recorded" ? <Text color={theme.value}> (recorded)</Text> : null}
      {invalid === "" ? null : <Text color={theme.error}>{invalid}</Text>}</Text>
  );
}

function PackageDetails({ row }: { readonly row: PackageRow }) {
  const version = row.installedVersion;
  const installedPrefix = version === undefined ? "" : row.installed.startsWith("installed at ") ? "installed at " : "installed ";
  const installedSuffix = version === undefined ? "" : row.installed.slice(installedPrefix.length + version.length);
  const status = row.status.kind === "unknown" && row.status.reason === "local changes"
    ? "update not checked · local changes"
    : row.status.kind === "unknown" ? "cannot assess" : row.status.kind === "current" ? "up to date" : "update available";
  return (
    <Text><Text color={theme.legend}>  </Text><Text color={theme.value}>{row.selection.host}  </Text>
      {version === undefined ? <Text color={theme.warning}>{row.installed}</Text> : <><Text color={theme.value}>{installedPrefix}</Text><Text color={theme.version}>{version}</Text><Text color={theme.value}>{installedSuffix}</Text></>}
      <Text color={theme.value}>  available </Text><Text color={row.available === "unknown" ? theme.warning : theme.version}>{row.available}</Text>
      <Text color={theme.warning}>  {status}</Text>{row.drift === undefined ? null : <Text color={theme.warning}>  drift: {row.drift}</Text>}
    </Text>
  );
}

/** One line of the Installations tree: cursor, indent, mark box, label and the leaf's details. */
export function TreeRowLine({ row, selected, marked }: {
  readonly row: VisibleRow<NodeData>;
  readonly selected: boolean;
  readonly marked: boolean;
}) {
  const item = row.node.data;
  const markable = item.kind !== "group" && item.kind !== "package";
  const leaf = !row.expandable && markable;
  const prefix = `${selected ? "> " : "  "}${"  ".repeat(row.depth)}${leaf ? (marked ? "[x] " : "[ ] ") : ""}`;
  return (
    <Text {...rowStyle(selected)} color={item.kind === "group" ? theme.group : undefined}>
      {prefix}{item.kind === "app" ? item.row.entry.recipe?.name ?? item.row.name ?? item.row.entry.file : describeNode(row)}
      {item.kind === "installation" ? (
        <Text><Text color={theme.legend}>  </Text><Text color={item.row.installed === "unknown" ? theme.warning : theme.version}>{item.row.installed}</Text>
          <Text color={theme.field}> ({item.row.policy})  [{item.row.selection.hosts.join(", ")}]</Text>
          {markersOf(item.row) === "" ? null : <Text color={theme.marker}>  {markersOf(item.row)}</Text>}</Text>
      ) : null}
      {item.kind === "app" ? <AppDetails row={item.row} /> : null}
      {item.kind === "package" ? <PackageDetails row={item.row} /> : null}
      {item.kind === "unmanaged" && describeLinks(item.group) !== "" ? (
        <Text color={theme.success}>{"  "}{describeLinks(item.group)}</Text>
      ) : null}
    </Text>
  );
}
