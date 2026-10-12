import { Box, Text, useWindowSize } from "ink";

import { rowStyle, theme } from "./theme.js";
import { BorderPanel, FieldLine, PreviewConfirm } from "./panel-parts.js";
import { previewViewport } from "./preview-window.js";
import { CHECKING, describeRefresh, describeUnknownReasons, REFRESHING, type Entry, type UpdatesListView, type UpdatesMessage } from "./updates-model.js";
import type { UpdatesMode } from "./updates-mode.js";
import { formatAgo, previewLineText, type UpdatesData } from "./updates.js";
import { updateModePreviewChrome, updateModePreviewLines, updateModeQuestion } from "./updates-preview.js";

/** What the last check found out: its age, how the sources were refreshed, and what failed. */
export function CheckStatus({ data, now }: { readonly data: UpdatesData; readonly now: number }) {
  const errors = data.results.filter((result) => result.error !== undefined);
  return (
    <BorderPanel title="Update check">
      <Text color={theme.field}>checked <Text color={theme.value}>{formatAgo(now - data.checkedAt)}</Text>
        <Text color={theme.legend}> · </Text><Text color={theme.value}>{describeRefresh(data)}</Text>
      </Text>
      {data.refresh.failed.map((failure) => (
        <Text key={failure.source} color={theme.warning}>Refresh failed for {failure.source}: {failure.reason}</Text>
      ))}
      {data.appError ? <Text color={theme.error}>Error (Apps): {data.appError}</Text> : null}
      {data.packageError ? <Text color={theme.error}>Error (Packages): {data.packageError}</Text> : null}
      {errors.map((result) => <Text key={result.scope} color={theme.error}>Error ({result.scope}): {result.error}</Text>)}
    </BorderPanel>
  );
}

/** One line of the list: an update, the fold of unassessable items, or one of those when unfolded. */
export function EntryLine({ entry, selected, checked, view, showUnknown }: {
  readonly entry: Entry;
  readonly selected: boolean;
  readonly checked: boolean;
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
  const { row } = entry;
  if (entry.kind === "unknown") {
    return (
      <Box flexDirection="column">
        <Text {...rowStyle(selected)}>{cursor}    {row.path}  {row.scope}</Text>
        <Text color={theme.muted}>{"        "}{row.kind === "package" && /local modifications|local changes/i.test(row.reason)
          ? `Update comparison unavailable: ${row.reason}`
          : row.reason}</Text>
      </Box>
    );
  }
  return (
    <Text {...rowStyle(selected)}>
      {cursor}{checked ? "[x]" : "[ ]"} {row.path}  {row.scope}  {row.policy}  {row.installed} {"->"} {row.available}
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
        <Box flexDirection="column">
          {message.lines.map((line, position) => <Text key={position} color={message.kind === "error" ? theme.error : theme.success}>{line}</Text>)}
        </Box>
      ) : null}
    </>
  );
}

/** The prompt of the preview and confirmation modes; browsing and the check itself show nothing. */
type CapturedUpdateMode = Extract<UpdatesMode, { readonly kind: "manual" | "preview" | "confirm-paths" }>;

function CapturedUpdatePreview({ mode }: { readonly mode: CapturedUpdateMode }) {
  const { rows, columns } = useWindowSize();
  const lines = updateModePreviewLines(mode).map(previewLineText);
  const chrome = updateModePreviewChrome(mode);
  const viewport = previewViewport(lines, mode.cursor, rows || 24, columns || 80, chrome);
  return (
    <PreviewConfirm
      title={chrome.title}
      lines={lines}
      cursor={mode.cursor}
      question={updateModeQuestion(mode, viewport.reachedEnd)}
      chrome={chrome}
    />
  );
}

export function ModePanel({ mode }: { readonly mode: UpdatesMode }) {
  switch (mode.kind) {
    case "manual":
      return <CapturedUpdatePreview mode={mode} />;
    case "browse":
      return null;
    case "busy":
      return mode.label === REFRESHING || mode.label === CHECKING ? null : (
        <BorderPanel title="Updates"><FieldLine label="Status" value={mode.label} /></BorderPanel>
      );
    case "preview":
    case "confirm-paths":
      return <CapturedUpdatePreview mode={mode} />;
  }
}
