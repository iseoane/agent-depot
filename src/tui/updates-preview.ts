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
      if (count === 0) return { title: "Update batch preview", consequence: "Nothing can be applied.", cancel: "[Enter/Esc] back" };
      const updates = `${count} ${count === 1 ? "update" : "updates"}`;
      return { title: "Update batch preview", action: `Apply ${updates}`, consequence: `Apply ${updates}? y/n` };
    }
    case "manual":
      return { title: "Manual App update", action: "Check now", consequence: "Manual step done, check now? y/n" };
    case "confirm-paths":
      return { title: "Confirm replacing non-canonical locations", action: "Replace these paths", consequence: "Replace exactly these paths? y/n" };
    default:
      return { title: "Updates" };
  }
}
