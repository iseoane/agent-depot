import { Box } from "ink";
import { Text } from "./safe-text.js";

import { rowStyle, theme } from "./theme.js";
import { BorderPanel, FieldLine, PagedPreview } from "./panel-parts.js";
import { usePreviewGeometry } from "./preview-window.js";
import { describeRefresh, describeUnknownReasons, type Entry, type UpdatesListView, type UpdatesMessage } from "./updates-model.js";
import type { UpdatesMode } from "./updates-mode.js";
import { formatAgo, type UpdatesData } from "./updates.js";
import { lineText } from "./preview-render.js";
import { groupCheckState, packageLeafLabel, type CheckState } from "./updates-tree.js";
import { updateModePreviewChrome, updateModePreviewLines } from "./updates-preview.js";

function updateResultField(line: string, defaultOk: boolean): { readonly ok: boolean; readonly label: string | undefined; readonly value: string } {
  if (line.startsWith("Update summary: ")) {
    const successful = /^Update summary: \d+ updated, 0 failed$/.test(line);
    return { ok: successful, label: "Update summary:", value: line.slice("Update summary: ".length) };
  }
  if (line.startsWith("Updated ")) return { ok: true, label: "Updated", value: line.slice("Updated ".length) };
  if (line.startsWith("Failed ")) return { ok: false, label: "Failed", value: line.slice("Failed ".length) };
  if (line.startsWith("Cancelled ")) return { ok: false, label: "Cancelled", value: line.slice("Cancelled ".length) };
  if (line === "Update cancelled") return { ok: true, label: undefined, value: line };
  return { ok: defaultOk, label: undefined, value: line };
}

/** What the last check found out: its age, how the sources were refreshed, and what failed. */
export function CheckStatus({ data, now }: { readonly data: UpdatesData; readonly now: number }) {
  const errors = data.results.filter((result) => result.error !== undefined);
  return (
    <BorderPanel title="Update check">
      <Text color={theme.field}>checked <Text color={theme.value}>{formatAgo(now - data.checkedAt)}</Text>
        <Text color={theme.legend}> · </Text><Text color={theme.value}>{describeRefresh(data)}</Text>
      </Text>
      {data.refresh.failed.map((failure) => (
        <Text key={failure.source}><Text color={theme.warning}>[WARN] </Text><FieldLine label="Refresh failed for" value={`${failure.source}: ${failure.reason}`} /></Text>
      ))}
      {data.appError ? <Text><Text color={theme.error}>[FAIL] </Text><FieldLine label="Error (Apps):" value={data.appError} /></Text> : null}
      {data.rows.filter(row => row.kind === "package" && row.check.status === "current" && row.check.reason !== undefined).map(row => (
        <Text key={row.key} color={theme.warning}>{row.path}: {row.reason}</Text>
      ))}
      {data.packageError ? <Text><Text color={theme.error}>[FAIL] </Text><FieldLine label="Error (Packages):" value={data.packageError} /></Text> : null}
      {errors.map((result) => <Text key={result.scope}><Text color={theme.error}>[FAIL] </Text><FieldLine label={`Error (${result.scope}):`} value={result.error ?? ""} /></Text>)}
    </BorderPanel>
  );
}

const BOX: Record<CheckState, string> = { all: "[x]", some: "[-]", none: "[ ]" };

/** One line of the list: an update, the fold of unassessable items, or one of those when unfolded. */
export function EntryLine({ entry, selected, checked, view, showUnknown }: {
  readonly entry: Entry;
  readonly selected: boolean;
  /** The selected row keys. */
  readonly checked: readonly string[];
  readonly view: UpdatesListView;
  readonly showUnknown: boolean;
}) {
  const cursor = selected ? "> " : "  ";
  if (entry.kind === "summary") {
    return (
      <Text {...rowStyle(selected)} color={theme.inactive}>
        {cursor}{view.unknown.length} cannot be checked {showUnknown ? "▾" : "▸"}{describeUnknownReasons(view.unknown)}
      </Text>
    );
  }
  if (entry.kind === "group") {
    const state = groupCheckState(entry.leafKeys, checked);
    return (
      <Text {...rowStyle(selected)}>
        {cursor}{"  ".repeat(entry.line.depth)}{BOX[state]} <Text color={theme.field}>{entry.line.expanded ? "▾" : "▸"} {entry.label}</Text>
      </Text>
    );
  }
  const { row } = entry;
  if (entry.kind === "unknown") {
    return (
      <Box flexDirection="column">
        <Text {...rowStyle(selected)}>{cursor}    <Text color={theme.field}>{row.path}</Text><Text color={theme.legend}>  </Text><Text color={theme.field}>{row.scope}</Text></Text>
        <Text color={theme.muted}>{"        "}{row.kind === "package" && /local modifications|local changes/i.test(row.reason)
          ? `Update comparison unavailable: ${row.reason}`
          : row.reason}</Text>
      </Box>
    );
  }
  return (
    <Text {...rowStyle(selected)}>
      {cursor}{"  ".repeat(entry.line.depth)}{BOX[checked.includes(row.key) ? "all" : "none"]} <Text color={theme.field}>{packageLeafLabel(row)}</Text><Text color={theme.legend}>  </Text><Text color={theme.field}>{row.scope}</Text><Text color={theme.legend}>  </Text><Text color={theme.field}>{row.policy}</Text><Text color={theme.legend}>  </Text><Text color={theme.value}>{row.installed}</Text><Text color={theme.legend}> -&gt; </Text><Text color={theme.value}>{row.available}</Text>
    </Text>
  );
}

/** Under the list: the window indicator, what is up to date or selected, and the last result. */
export function UpdatesFooter({ indicator, upToDate, updatableCount, checkedCount, message }: {
  readonly indicator: string | undefined;
  readonly upToDate: number;
  readonly updatableCount: number;
  readonly checkedCount: number;
  readonly message: UpdatesMessage | undefined;
}) {
  return (
    <>
      {indicator ? <Text color={theme.muted}>{indicator}</Text> : null}
      {upToDate > 0 ? <Text color={theme.muted}>{upToDate} up to date</Text> : null}
      {updatableCount > 0 ? <Text color={theme.muted}>{checkedCount} selected</Text> : null}
      {message ? (
        <BorderPanel title="Update result">
          {message.lines.map((line, position) => {
            const result = updateResultField(line, message.kind === "ok");
            return <Text key={position}><Text color={result.ok ? theme.success : theme.error}>[{result.ok ? "OK" : "FAIL"}] </Text>{result.label === undefined ? <Text color={theme.value}>{result.value}</Text> : <FieldLine label={result.label} value={result.value} />}</Text>;
          })}
        </BorderPanel>
      ) : null}
    </>
  );
}

/** The prompt of the preview and confirmation modes; browsing and the check itself show nothing. */
type CapturedUpdateMode = Extract<UpdatesMode, { readonly kind: "manual" | "preview" | "confirm-paths" }>;

function CapturedUpdatePreview({ mode }: { readonly mode: CapturedUpdateMode }) {
  const styled = updateModePreviewLines(mode);
  const lines = styled.map(lineText);
  const chrome = updateModePreviewChrome(mode);
  return <PagedPreview lines={lines} styled={styled} viewport={usePreviewGeometry()(lines, mode.cursor, chrome)} />;
}

export function ModePanel({ mode }: { readonly mode: UpdatesMode }) {
  switch (mode.kind) {
    case "manual":
      return <CapturedUpdatePreview mode={mode} />;
    case "browse":
      return null;
    case "busy":
      // The view renders the one indicator of a busy mode, so a check never shows two.
      return null;
    case "preview":
    case "confirm-paths":
      return <CapturedUpdatePreview mode={mode} />;
  }
}
