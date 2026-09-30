import { Box, Text } from "ink";

import type { ProjectHost } from "../project-manifest.js";
import { theme } from "./theme.js";

/** The `> [x] 1 name` rows of a checklist; the caller renders the header. */
export function ChecklistLines<T>({ choices, cursor, isSelected, keyOf, label }: {
  readonly choices: readonly T[];
  readonly cursor: number;
  readonly isSelected: (choice: T) => boolean;
  readonly keyOf: (choice: T) => string;
  readonly label: (choice: T) => string;
}) {
  return (
    <>
      {choices.map((choice, position) => (
        <Text key={keyOf(choice)}>
          {position === cursor ? "> " : "  "}[{isSelected(choice) ? "x" : " "}] {position + 1} {label(choice)}
        </Text>
      ))}
    </>
  );
}

/** The host rows of a checklist. */
export function HostChecklist({ choices, cursor, selected }: {
  readonly choices: readonly ProjectHost[];
  readonly cursor: number;
  readonly selected: readonly ProjectHost[];
}) {
  return <ChecklistLines choices={choices} cursor={cursor} isSelected={(host) => selected.includes(host)} keyOf={(host) => host} label={(host) => host} />;
}

/** Preview lines; `warnFirst` colors the first one as a warning. */
export function PreviewLines({ lines, warnFirst = false }: { readonly lines: readonly string[]; readonly warnFirst?: boolean }) {
  return (
    <>
      {lines.map((line, position) => <Text key={position} color={warnFirst && position === 0 ? theme.warning : undefined}>{line}</Text>)}
    </>
  );
}

/** Under a list: the window indicator, how many items are marked, and the last result. */
export function ListFooter({ indicator, selectedCount, message }: {
  readonly indicator: string | undefined;
  readonly selectedCount: number;
  readonly message: { readonly kind: "ok" | "error"; readonly text: string } | undefined;
}) {
  return (
    <>
      {indicator ? <Text color={theme.muted}>{indicator}</Text> : null}
      {selectedCount > 0 ? <Text color={theme.muted}>{selectedCount} selected</Text> : null}
      {message ? <Text color={message.kind === "error" ? theme.error : theme.success}>{message.text}</Text> : null}
    </>
  );
}

/** A preview followed by a y/n question. */
export function PreviewConfirm({ lines, question, warnFirst }: {
  readonly lines: readonly string[];
  readonly question: string;
  readonly warnFirst?: boolean;
}) {
  return (
    <Box flexDirection="column">
      <PreviewLines lines={lines} warnFirst={warnFirst} />
      <Text>{question}</Text>
    </Box>
  );
}
