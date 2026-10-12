import type { UpdatesMode } from "./updates-mode.js";
import { previewText, type UpdatePreviewLine } from "./updates.js";
import type { PreviewChrome } from "./preview-window.js";

export function updateModePreviewLines(mode: UpdatesMode): readonly UpdatePreviewLine[] {
  switch (mode.kind) {
    case "preview":
      return [
        ...mode.prepared.lines,
        ...mode.prepared.appFailures.map(previewText),
        ...mode.prepared.packageFailures.map(previewText),
        ...mode.prepared.failures.map(({ item, message }) => previewText(`Preview failed for ${JSON.stringify(item.id)}: ${message}`)),
      ];
    case "manual":
      return [
        { kind: "field", label: "App:", value: mode.plan.entry.recipe?.name ?? mode.plan.entry.file },
        { kind: "field", label: "Environment:", value: mode.plan.environment },
        { kind: "field", label: "Working directory:", value: mode.plan.cwd },
        { kind: "field", label: "Manual:", value: mode.plan.manual ?? "" },
        ...(mode.reason === undefined ? [] : [previewText(mode.reason)]),
      ];
    case "confirm-paths":
      return [
        previewText("Outside .agents/skills and .claude/skills:"),
        ...mode.prepared.nonCanonicalPaths.map(({ scope, path }) => ({
          kind: "field" as const,
          label: "Path:",
          value: `[${scope}] ${JSON.stringify(path)}`,
        })),
      ];
    default:
      return [];
  }
}

export function updateModePreviewChrome(mode: UpdatesMode): PreviewChrome {
  switch (mode.kind) {
    case "preview": {
      const count = mode.prepared.applicable.length;
      const question = `Apply ${count} ${count === 1 ? "update" : "updates"}? y/n`;
      return {
        title: "Update batch preview",
        questions: ["Scroll to end before confirming; n cancels.", question],
        footerRows: 2,
      };
    }
    case "manual":
      return {
        title: "Manual App update",
        questions: ["Scroll to end before confirming; n cancels.", "Manual step done, check now? y/n"],
        footerRows: 2,
      };
    case "confirm-paths":
      return {
        title: "Confirm replacing non-canonical locations",
        questions: ["Scroll to end before confirming; n cancels.", "Replace exactly these paths? y/n"],
        footerRows: 2,
      };
    default:
      return { title: "Updates", questions: ["Continue? y/n"] };
  }
}

export function updateModeQuestion(mode: UpdatesMode, reachedEnd: boolean): string {
  if (mode.kind === "preview" && mode.prepared.applicable.length === 0) {
    return "Nothing can be applied. Enter or Esc to go back.";
  }
  const chrome = updateModePreviewChrome(mode);
  return reachedEnd ? chrome.questions.at(-1) ?? "Continue? y/n" : chrome.questions[0] ?? "Scroll to end before confirming; n cancels.";
}
