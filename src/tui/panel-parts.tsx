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

type PreviewSpan = { readonly text: string; readonly color?: string; readonly bold?: boolean };

function previewSpan(text: string, color: string, bold = false): PreviewSpan {
  return { text, color, bold };
}

function profilePreviewSpans(line: string): readonly PreviewSpan[] | undefined {
  if (line.startsWith("Destination: ")) {
    return [previewSpan("Destination:", theme.field), previewSpan(line.slice("Destination:".length), theme.value)];
  }
  if (line === "Preview: export portable user-global profile" || line === "Preview: import portable user-global profile") {
    return [previewSpan("Preview:", theme.field), previewSpan(line.slice("Preview:".length), theme.value)];
  }
  if (line.startsWith("WARNING:")) return [previewSpan(line, theme.warning)];

  const source = /^Source (git:[^ ]+) (.+) \(included: (true|false)\)$/u.exec(line);
  if (source) return [previewSpan("Source", theme.field), previewSpan(" ", theme.value),
    previewSpan(source[1]!, theme.muted), previewSpan(" ", theme.value), previewSpan(source[2]!, theme.value),
    previewSpan(" (", theme.value), previewSpan("included:", theme.field), previewSpan(` ${source[3]})`, theme.value)];

  const skill = /^Skill (.+) \[([^\]]*)\] \((latest|fixed(?: [^)]+)?)\)$/u.exec(line);
  if (skill) return [previewSpan("Skill", theme.field), previewSpan(" ", theme.value), previewSpan(skill[1]!, theme.value, true),
    previewSpan(" [", theme.value), previewSpan(skill[2]!, theme.marker), previewSpan("] (", theme.value),
    previewSpan(skill[3]!, theme.version), previewSpan(")", theme.value)];

  const app = /^App recipe (.+) \(([^;]+); approval not transferred\)$/u.exec(line);
  if (app) return [previewSpan("App recipe", theme.field), previewSpan(" ", theme.value), previewSpan(app[1]!, theme.value, true),
    previewSpan(" (", theme.value), previewSpan(app[2]!, theme.marker), previewSpan("; approval not transferred)", theme.value)];

  const packageLine = /^Package (.+) from (.+) \((latest|fixed [^;]+); saved selection\)(.*)$/u.exec(line);
  if (packageLine) return [previewSpan("Package", theme.field), previewSpan(" ", theme.value),
    previewSpan(packageLine[1]!, theme.value, true), previewSpan(" from ", theme.value), previewSpan(packageLine[2]!, theme.value),
    previewSpan(" (", theme.value), previewSpan(packageLine[3]!, theme.version),
    previewSpan(`; saved selection)${packageLine[4]}`, theme.value)];

  const replica = /^Replica intent (Installed Skill|Installed App|Installed Package) (.+?)(; .*)?$/u.exec(line);
  if (replica) return [previewSpan("Replica intent", theme.field), previewSpan(" ", theme.value),
    previewSpan(replica[1]!, theme.field), previewSpan(" ", theme.value), previewSpan(replica[2]!, theme.value, true),
    previewSpan(replica[3] ?? "", theme.value)];

  if (line.startsWith("  Source ")) return [previewSpan("  Source", theme.field), previewSpan(line.slice("  Source".length), theme.value)];
  if (line.startsWith("Origin replica intent:")) return [previewSpan("Origin replica intent:", theme.field),
    previewSpan(line.slice("Origin replica intent:".length), theme.value)];

  const imported = /^(add|same|conflict|skip)( \(discovery inclusion is not imported\))?: (Source|Skill|App recipe|Package) (.+)$/u.exec(line);
  if (imported) return [previewSpan(`${imported[1]}${imported[2] ?? ""}:`, theme.field), previewSpan(` ${imported[3]}`, theme.field),
    previewSpan(" ", theme.value), previewSpan(imported[4]!, theme.value, true)];

  const hosts = /^ {2}hosts: ([^;]*); version policy: (latest|fixed(?: .+)?)$/u.exec(line);
  if (hosts) return [previewSpan("  hosts:", theme.field), previewSpan(" ", theme.value),
    previewSpan(hosts[1]!, theme.marker), previewSpan("; ", theme.value), previewSpan("version policy:", theme.field),
    previewSpan(` ${hosts[2]}`, theme.version)];

  return undefined;
}

export function PreviewLines({ lines, warnFirst = false }: {
  readonly lines: readonly string[];
  readonly warnFirst?: boolean;
}) {
  return (
    <>
      {lines.map((line, position) => {
        const profileSpans = profilePreviewSpans(line);
        if (profileSpans) return <Text key={position}>{profileSpans.map((span, index) =>
          <Text key={index} color={span.color} bold={span.bold}>{span.text}</Text>)}</Text>;
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
