import { Box } from "ink";
import { PreEscapedText, Text } from "./safe-text.js";
import { useEffect, useState, type ReactNode } from "react";

import type { ProjectHost } from "../project-manifest.js";
import { theme } from "./theme.js";
import type { StyledLine } from "./preview-render.js";
import { escapeControlText, sliceSpans, type PreviewFooterRole, type PreviewViewport } from "./preview-window.js";
import { animationEnabled, formatElapsed, SPINNER_FRAMES, SPINNER_TICK_MS, STATIC_GLYPH } from "./working-model.js";

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

/**
 * A spinner, the label and, from one second on, the time since `since` (when the operation began, not
 * when this line mounted, so the clock survives label changes). Without animation it is a static line.
 */
export function Working({ label, since, now, animate }: {
  readonly label: string;
  readonly since: number;
  readonly now?: () => number;
  readonly animate?: boolean;
}) {
  const animated = animate ?? animationEnabled();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!animated) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), SPINNER_TICK_MS);
    // A redraw timer alone must never keep the process alive.
    timer.unref();
    return () => clearInterval(timer);
  }, [animated]);
  const elapsed = animated ? formatElapsed((now ?? Date.now)() - since) : "";
  return (
    <Text>
      <Text color={theme.accent}>{animated ? SPINNER_FRAMES[tick % SPINNER_FRAMES.length] : STATIC_GLYPH}</Text>
      <Text color={theme.value}> {label}</Text>
      {elapsed ? <Text color={theme.legend}> {elapsed}</Text> : null}
    </Text>
  );
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

/** The colour of a warning, host exposure notice or refusal, which the flows indent to different depths. */
function noticeColor(line: string): string | undefined {
  const text = line.trimStart();
  if (text.startsWith("WARNING:") || text.startsWith("ADDITIONAL HOST EXPOSURE:") || text.startsWith("Skipped ")) return theme.warning;
  return text.startsWith("Cannot install ") ? theme.error : undefined;
}

/** The hanging prefix of a continuation row, drawn in the gutter colour, then the part of the line's spans the row shows. */
function rowSpans<T extends PreviewSpan>(spans: readonly T[], prefix: string, offset: number, length: number): readonly PreviewSpan[] {
  return [...(prefix === "" ? [] : [previewSpan(prefix, theme.field)]), ...sliceSpans(spans, offset, length)];
}

function PreviewLine({ line, position, logicalLine, offset = 0, prefixLength = 0 }: {
  readonly line: string;
  readonly position: number;
  readonly logicalLine?: string;
  readonly offset?: number;
  readonly prefixLength?: number;
}) {
  const prefix = line.slice(0, prefixLength);
  const textLength = line.length - prefixLength;
  const profileSpans = logicalLine === undefined ? profilePreviewSpans(line) : profilePreviewSpans(logicalLine);
  if (profileSpans) {
    const spans = logicalLine === undefined ? profileSpans : rowSpans(profileSpans, prefix, offset, textLength);
    return <PreEscapedText key={position}>{spans.map((span, index) =>
      <PreEscapedText key={index} color={span.color} bold={span.bold}>{span.text}</PreEscapedText>)}</PreEscapedText>;
  }
  const field = previewField(logicalLine ?? line);
  if (field) {
    const fieldSpans = [previewSpan(field.label, theme.field), previewSpan(field.value, theme.value)];
    const spans = logicalLine === undefined ? fieldSpans : rowSpans(fieldSpans, prefix, offset, textLength);
    return <PreEscapedText key={position}>{spans.map((span, index) =>
      <PreEscapedText key={index} color={span.color}>{span.text}</PreEscapedText>)}</PreEscapedText>;
  }
  return <PreEscapedText key={position} color={noticeColor(logicalLine ?? line) ?? theme.value}>{line}</PreEscapedText>;
}

export function PreviewLines({ lines }: { readonly lines: readonly string[] }) {
  return <>{lines.map((line, position) =>
    <PreviewLine key={position} line={escapeControlText(line)} position={position} />)}</>;
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

function footerColor(role: PreviewFooterRole, reachedEnd: boolean): { readonly color: string; readonly bold?: boolean } {
  switch (role) {
    case "read": return { color: theme.success };
    case "reading": return { color: theme.warning };
    case "consequence": return { color: theme.warning };
    case "yes": return { color: theme.success, bold: true };
    case "no": return { color: theme.error };
    case "action": return reachedEnd ? { color: theme.success, bold: true } : { color: theme.muted };
    case "position":
    case "cancel": return { color: theme.legend };
  }
}

/**
 * A paged preview with the shared two-row footer: reading progress, then what `y` does. `[y]` stays
 * dimmed until `viewport` reaches the end; callers ignore `y` until then using the same viewport.
 */
export function PagedPreview({ lines: rawLines, styled: rawStyled, viewport }: {
  readonly lines: readonly string[];
  /** Colours of each line in `lines`; a line without them has its colours inferred from the text. */
  readonly styled?: readonly (StyledLine | undefined)[];
  readonly viewport: PreviewViewport;
}) {
  // The same escape `previewViewport` applied, so rows, offsets and spans describe the same text. The rows themselves are already
  // escaped, hence `PreEscapedText`; only the title goes through `BorderPanel`.
  const lines = rawLines.map(escapeControlText);
  const styled = rawStyled?.map((line) => line?.map((span) => ({ ...span, text: escapeControlText(span.text) })));
  return (
    <BorderPanel title={viewport.title}>
      {viewport.rows.map((line, position) => {
        const logical = viewport.sourceLines[position]!;
        const custom = styled?.[logical];
        return custom === undefined
          ? <PreviewLine key={position} line={line} position={position}
            logicalLine={lines[logical]!}
            offset={viewport.sourceOffsets[position]!}
            prefixLength={viewport.prefixLengths[position]!} />
          : <PreEscapedText key={position}>{rowSpans(custom, line.slice(0, viewport.prefixLengths[position]!), viewport.sourceOffsets[position]!, line.length - viewport.prefixLengths[position]!).map((span, index) =>
            <PreEscapedText key={index} color={span.color} bold={span.bold}>{span.text}</PreEscapedText>)}</PreEscapedText>;
      })}
      {viewport.footer.map((spans, row) => <PreEscapedText key={`footer-${row}`}>{spans.map((span, index) =>
        <PreEscapedText key={index} {...footerColor(span.role, viewport.reachedEnd)}>{span.text}</PreEscapedText>)}</PreEscapedText>)}
    </BorderPanel>
  );
}
