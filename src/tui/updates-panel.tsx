import { Box, Text } from "ink";

import { rowStyle, theme } from "./theme.js";
import { CHECKING, describeRefresh, describeUnknownReasons, REFRESHING, type Entry, type UpdatesListView, type UpdatesMessage } from "./updates-model.js";
import type { UpdatesMode } from "./updates-mode.js";
import { formatAgo, type UpdatesData } from "./updates.js";
import { PreviewLines } from "./panel-parts.js";

/** What the last check found out: its age, how the sources were refreshed, and what failed. */
export function CheckStatus({ data, now }: { readonly data: UpdatesData; readonly now: number }) {
  const errors = data.results.filter((result) => result.error !== undefined);
  return (
    <>
      <Text color={theme.muted}>checked {formatAgo(now - data.checkedAt)} · {describeRefresh(data)}</Text>
      {data.refresh.failed.map((failure) => (
        <Text key={failure.source} color={theme.warning}>refresh failed for {failure.source}: {failure.reason}</Text>
      ))}
      {data.appError ? <Text color={theme.error}>Error (Apps): {data.appError}</Text> : null}
      {data.packageError ? <Text color={theme.error}>Error (Packages): {data.packageError}</Text> : null}
      {errors.map((result) => <Text key={result.scope} color={theme.error}>Error ({result.scope}): {result.error}</Text>)}
    </>
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
        <Text color={theme.muted}>{"        "}{row.reason}</Text>
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
export function ModePanel({ mode }: { readonly mode: UpdatesMode }) {
  switch (mode.kind) {
    case "manual":
      return (
        <Box flexDirection="column">
          <Text>App: {mode.plan.entry.recipe!.name}</Text>
          <Text>Environment: {mode.plan.environment}</Text>
          <Text>Working directory: {mode.plan.cwd}</Text>
          <Text>Manual: {mode.plan.manual}</Text>
          {mode.reason ? <Text color={theme.warning}>{mode.reason}</Text> : null}
          <Text>Manual step done, check now? y/n</Text>
        </Box>
      );
    case "browse":
      return null;
    case "busy":
      return mode.label === REFRESHING || mode.label === CHECKING ? null : <Text>{mode.label}</Text>;
    case "preview":
      return (
        <Box flexDirection="column">
          <PreviewLines lines={mode.prepared.lines} />
          <PreviewLines lines={mode.prepared.appFailures} />
          <PreviewLines lines={mode.prepared.packageFailures} />
          {mode.prepared.failures.map(({ item, message }) => (
            <Text key={item.id} color={theme.error}>Preview failed for {JSON.stringify(item.id)}: {message}</Text>
          ))}
          {mode.prepared.applicable.length === 0
            ? <Text>Nothing can be applied. Enter/Esc to go back</Text>
            : <Text>Apply {mode.prepared.applicable.length} {mode.prepared.applicable.length === 1 ? "update" : "updates"}? y/n</Text>}
        </Box>
      );
    case "confirm-paths":
      return (
        <Box flexDirection="column">
          <Text color={theme.warning}>Confirm replacing non-canonical locations (outside .agents/skills and .claude/skills):</Text>
          {mode.prepared.nonCanonicalPaths.map((location, position) => <Text key={position} color={theme.warning}>  [{location.scope}] {JSON.stringify(location.path)}</Text>)}
          <Text>Replace exactly these paths? y/n</Text>
        </Box>
      );
  }
}
