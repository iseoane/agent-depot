import { Box, Text, useWindowSize } from "ink";

import { rowStyle, theme } from "./theme.js";
import { BorderPanel, DecisionPrompt, FieldLine } from "./panel-parts.js";
import { previewViewport } from "./preview-window.js";
import { CHECKING, describeRefresh, describeUnknownReasons, REFRESHING, type Entry, type UpdatesListView, type UpdatesMessage } from "./updates-model.js";
import type { UpdatesMode } from "./updates-mode.js";
import { formatAgo, previewLineText, previewText, type UpdatePreviewLine, type UpdatesData } from "./updates.js";

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
export function ModePanel({ mode }: { readonly mode: UpdatesMode }) {
  const { rows, columns } = useWindowSize();
  switch (mode.kind) {
    case "manual":
      return (
        <BorderPanel title="Manual App update">
          <FieldLine label="App" value={mode.plan.entry.recipe!.name} />
          <FieldLine label="Environment" value={mode.plan.environment} />
          <FieldLine label="Working directory" value={mode.plan.cwd} />
          <FieldLine label="Manual step" value={mode.plan.manual} />
          {mode.reason ? <Text color={theme.warning}>{mode.reason}</Text> : null}
          <DecisionPrompt>Manual step done, check now?</DecisionPrompt>
        </BorderPanel>
      );
    case "browse":
      return null;
    case "busy":
      return mode.label === REFRESHING || mode.label === CHECKING ? null : (
        <BorderPanel title="Updates"><FieldLine label="Status" value={mode.label} /></BorderPanel>
      );
    case "preview": {
      const lines: UpdatePreviewLine[] = [
        ...mode.prepared.lines,
        ...mode.prepared.appFailures.map(previewText),
        ...mode.prepared.packageFailures.map(previewText),
        ...mode.prepared.failures.map(({ item, message }) => previewText(`Preview failed for ${JSON.stringify(item.id)}: ${message}`)),
      ];
      const displayLines = lines.map(previewLineText);
      const question = mode.prepared.applicable.length === 0
        ? "Nothing can be applied. Enter or Esc to go back."
        : "Scroll to end before confirming; n cancels.";
      const chrome = { title: "Update batch preview", questions: [question, "Apply this update batch? y/n"], reservedRows: 1 };
      const viewport = previewViewport(displayLines, mode.cursor, rows || 24, columns || 80, chrome);
      return (
        <BorderPanel title={chrome.title}>
          {viewport.rows.map((line, position) => {
            const source = lines[viewport.sourceLines[position] ?? -1];
            return source?.kind === "field" && line.startsWith(source.label)
              ? <Text key={position}><Text color={theme.field}>{source.label}</Text><Text color={theme.value}>{line.slice(source.label.length)}</Text></Text>
              : <Text key={position} color={theme.value}>{line}</Text>;
          })}
          {viewport.total > viewport.height ? <Text color={theme.legend}>{viewport.start + 1}–{viewport.end} of {viewport.total}</Text> : null}
          <Text color={theme.legend}>Review {viewport.cursor + 1} of {viewport.total} · j/k · PgUp/PgDn</Text>
          {mode.prepared.applicable.length === 0
            ? <Text color={theme.legend}>{question}</Text>
            : viewport.reachedEnd
              ? <DecisionPrompt>Apply {mode.prepared.applicable.length} {mode.prepared.applicable.length === 1 ? "update" : "updates"}?</DecisionPrompt>
              : <Text color={theme.legend}>{question}</Text>}
        </BorderPanel>
      );
    }
    case "confirm-paths":
      return (
        <BorderPanel title="Confirm replacing non-canonical locations">
          <Text color={theme.warning}>Outside .agents/skills and .claude/skills:</Text>
          {mode.prepared.nonCanonicalPaths.map((location, position) => (
            <Text key={position}><Text color={theme.field}>[{location.scope}] </Text><Text color={theme.value}>{JSON.stringify(location.path)}</Text></Text>
          ))}
          <DecisionPrompt>Replace exactly these paths?</DecisionPrompt>
        </BorderPanel>
      );
  }
}
