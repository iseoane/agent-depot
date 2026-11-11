import { commandLine, itemWarnings, type PreviewDocument, type PreviewItem, type PreviewRow } from "../preview-model.js";
import { theme } from "./theme.js";

export interface StyledSpan {
  readonly text: string;
  readonly color: string;
  readonly bold?: boolean;
}

/** One logical preview line; the preview window wraps its joined text and slices the spans to match. */
export type StyledLine = readonly StyledSpan[];

export const span = (text: string, color: string, bold = false): StyledSpan => bold ? { text, color, bold } : { text, color };

// Ink drops the height of an empty Text, so a blank separator keeps one space.
const BLANK: StyledLine = [span(" ", theme.value)];

export function lineText(line: StyledLine): string {
  return line.map(({ text }) => text).join("");
}

export function textLine(text: string): StyledLine {
  return [span(text, theme.value)];
}

export function fieldLine(label: string, value: string): StyledLine {
  return [span(label, theme.field), span(` ${value}`, theme.value)];
}

const ROW_INDENT = "   ";

function rowLines(row: PreviewRow): readonly StyledLine[] {
  switch (row.kind) {
    case "field":
      return [[span(`${ROW_INDENT}${row.label}:`, theme.field), ...(row.value === "" ? [] : [span(` ${row.value}`, theme.value)])]];
    case "text":
      return [[span(`${ROW_INDENT}${"  ".repeat(row.indent ?? 0)}${row.text}`, theme.value)]];
    case "warning":
      return [[span(`${ROW_INDENT}⚠ ${row.text}`, theme.warning)]];
    case "command": {
      const where = [row.executable, row.cwd === undefined ? undefined : `in ${row.cwd}`].filter((part) => part !== undefined);
      return [
        [span(`${ROW_INDENT}$ ${commandLine(row.argv)}`, theme.value)],
        ...(where.length === 0 ? [] : [[span(`${ROW_INDENT}${where.join(" · ")}`, theme.legend)]]),
      ];
    }
  }
}

function itemLines(item: PreviewItem): readonly StyledLine[] {
  const title: StyledSpan[] = [span(` ${item.title}`, theme.value, true)];
  if (item.detail !== undefined) title.push(span(`  ${item.detail}`, theme.legend));
  if (item.version !== undefined) title.push(span(`  ${item.version.from} → ${item.version.to}`, theme.version));
  return [title, ...item.rows.flatMap(rowLines)];
}

/** One recipe step as previewed: a command or a manual instruction, and where it would run. */
export interface StepPreview {
  readonly step: string;
  readonly argv?: readonly string[];
  readonly manual?: string;
  /** The resolved executable; absent when it was not found in PATH. */
  readonly executable?: string;
  readonly cwd: string;
  readonly warning?: string;
  readonly environment?: string;
  readonly declaration?: string;
  readonly pattern?: string;
}

/** One block per step joined by a tree gutter: what the step runs or asks for, then dimmed where it runs. */
export function stepBlockLines(steps: readonly StepPreview[]): readonly StyledLine[] {
  return steps.flatMap((step, index) => {
    const last = index === steps.length - 1;
    const branch = last ? "└" : index === 0 ? "┌" : "├";
    const row = (...spans: StyledSpan[]): StyledLine => [span(last ? "   " : " │ ", theme.field), ...spans];
    const where = [`in ${step.cwd}`, ...(step.environment ? [`on ${step.environment}`] : [])].join(" · ");
    return [
      [span(` ${branch} ${step.step}`, theme.field)],
      ...(step.argv ? [row(span(`$ ${commandLine(step.argv)}`, theme.value))] : []),
      ...(step.manual ? [row(span(`Manual: ${step.manual}`, theme.value))] : []),
      ...(step.declaration ? [row(span(step.declaration, theme.value))] : []),
      ...(step.pattern ? [row(span(`Version pattern: ${step.pattern}`, theme.value))] : []),
      step.argv && step.executable === undefined
        ? row(span(`${commandLine(step.argv.slice(0, 1))} not found in PATH`, theme.warning), span(` · ${where}`, theme.legend))
        : row(span(step.executable ? `${step.executable} · ${where}` : where, theme.legend)),
      ...(step.warning ? [row(span(`⚠ ${step.warning}`, theme.warning))] : []),
    ];
  });
}

/** The document as preview lines: action and counts, context, every warning, one section per type, then the failures. */
export function renderPreviewDocument(document: PreviewDocument): readonly StyledLine[] {
  const warnings = [
    ...document.warnings,
    ...document.sections.flatMap(({ items }) => items.flatMap((item) => itemWarnings(item).map((warning) => `${item.title}: ${warning}`))),
  ];
  const lines: StyledLine[] = [
    [span(document.action, theme.accent, true), span(`  ${document.summary}`, theme.legend)],
    ...document.context.map((line) => [span(` ${line}`, theme.legend)]),
    ...warnings.map((warning) => [span(` ⚠ ${warning}`, theme.warning)]),
  ];
  for (const section of document.sections) {
    lines.push(BLANK, [span(section.heading, theme.field, true)]);
    section.items.forEach((item, position) => {
      if (position > 0) lines.push(BLANK);
      lines.push(...itemLines(item));
    });
  }
  if (document.failures.length > 0) {
    lines.push(BLANK, [span("FAILED", theme.error, true)], ...document.failures.map((failure) => [span(` ${failure}`, theme.error)]));
  }
  return lines;
}
