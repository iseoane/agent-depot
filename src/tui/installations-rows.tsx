import { Text } from "ink";

import { describeDetails, describeLinks, describeNode, markersOf, type NodeData } from "./installations-tree.js";
import { describePackageRow } from "./package-rows.js";
import { rowStyle, theme } from "./theme.js";
import type { VisibleRow } from "./tree.js";

/** One line of the Installations tree: cursor, indent, mark box, label and the leaf's details. */
export function TreeRowLine({ row, selected, marked }: {
  readonly row: VisibleRow<NodeData>;
  readonly selected: boolean;
  readonly marked: boolean;
}) {
  const item = row.node.data;
  const leaf = !row.expandable && item.kind !== "group";
  const prefix = `${selected ? "> " : "  "}${"  ".repeat(row.depth)}${leaf ? (marked ? "[x] " : "[ ] ") : ""}`;
  return (
    <Text {...rowStyle(selected)} color={item.kind === "group" ? theme.group : undefined}>
      {prefix}{describeNode(row)}
      {item.kind === "installation" ? (
        <Text color={theme.marker}>{"  "}{describeDetails(item.row)}{markersOf(item.row) === "" ? "" : `  ${markersOf(item.row)}`}</Text>
      ) : null}
      {item.kind === "package" ? (
        <Text color={theme.marker}>{"  "}{describePackageRow(item.row)}</Text>
      ) : null}
      {item.kind === "unmanaged" && describeLinks(item.group) !== "" ? (
        <Text color={theme.marker}>{"  "}{describeLinks(item.group)}</Text>
      ) : null}
    </Text>
  );
}
