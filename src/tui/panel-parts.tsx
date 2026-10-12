import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";

import type { ProjectHost } from "../project-manifest.js";
import { theme } from "./theme.js";
import { previewViewport, type PreviewChrome } from "./preview-window.js";

/** A titled, color-independent boundary for a focused interaction or result. */
export function BorderPanel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>{title}</Text>
      {children}
    </Box>
  );
}

export function FieldLine({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return <Text><Text color={theme.field}>{label}</Text><Text color={theme.value}> {value}</Text></Text>;
}

export function DecisionPrompt({ children }: { readonly children: ReactNode }) {
  return (
    <Text>
      <Text color={theme.warning}>{children}</Text> <Text color={theme.success} bold>y</Text><Text color={theme.legend}>/</Text><Text color={theme.error}>n</Text>
    </Text>
  );
}

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
const PREVIEW_FIELD_LABELS = [
  "File:", "Name:", "Platform:", "Status:", "Homepage:", "Owned Skills:",
  "App:", "Environment:", "Version:", "argv:", "Executable:", "Manual:",
  "Declaration:", "Version pattern:", "Working directory:", "Previous version:",
  "Latest version:", "Package:", "Host:", "Source:", "Scope:", "Coordinates:", "Origin:",
  "Available:", "Approval:", "Path:", "Blast radius:", "Warning:", "  target:", "  proposed changes:",
  "  external command:", "  external cwd:", "  external target:",
] as const;

function previewField(line: string): { readonly label: string; readonly value: string } | undefined {
  const label = PREVIEW_FIELD_LABELS.find(candidate => line.startsWith(candidate));
  return label === undefined ? undefined : { label, value: line.slice(label.length) };
}

export function PreviewLines({ lines, warnFirst = false }: {
  readonly lines: readonly string[];
  readonly warnFirst?: boolean;
}) {
  return (
    <>
      {lines.map((line, position) => {
        const field = previewField(line);
        return field ? (
          <Text key={position}>
            <Text color={theme.field}>{field.label}</Text><Text color={theme.value}>{field.value}</Text>
          </Text>
        ) : <Text key={position} color={warnFirst && position === 0 ? theme.warning : theme.value}>{line}</Text>;
      })}
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
      {message ? (
        <BorderPanel title={message.kind === "error" ? "Result · failed" : "Result · complete"}>
          <Text color={message.kind === "error" ? theme.error : theme.success}>{message.text}</Text>
        </BorderPanel>
      ) : null}
    </>
  );
}

/** A preview followed by a y/n question. */
export function PreviewConfirm({ title = "Confirmation", lines, question, warnFirst, cursor, chrome }: {
  readonly title?: string;
  readonly lines: readonly string[];
  readonly question: string;
  readonly warnFirst?: boolean;
  readonly cursor?: number;
  readonly chrome?: PreviewChrome;
}) {
  const { rows, columns } = useWindowSize();
  const viewport = cursor === undefined ? undefined : previewViewport(lines, cursor, rows || 24, columns || 80, chrome ?? { title, questions: [question], footerRows: 2 });
  const shown = viewport?.rows ?? lines;
  return (
    <BorderPanel title={title}>
      <PreviewLines lines={shown} warnFirst={warnFirst && (viewport?.start ?? 0) === 0} />
      {viewport && viewport.total > viewport.height ? <Text color={theme.muted}>{viewport.start + 1}–{viewport.end} of {viewport.total}</Text> : null}
      {viewport ? <Text color={theme.legend}>Review {viewport.cursor + 1} of {viewport.total} · arrows/Pg page</Text> : null}
      {question.includes("y/n") ? (() => {
        const marker = question.indexOf("y/n");
        return <Text><Text color={theme.warning}>{question.slice(0, marker)}</Text><Text color={theme.success} bold>y</Text><Text color={theme.legend}>/</Text><Text color={theme.error}>n</Text><Text color={theme.legend}>{question.slice(marker + 3)}</Text></Text>;
      })() : <Text color={theme.legend}>{question}</Text>}
    </BorderPanel>
  );
}
