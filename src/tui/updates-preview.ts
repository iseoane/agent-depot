import { quoteText } from "../preview-model.js";
import { appPlanLines } from "./app-actions.js";
import type { UpdatesMode } from "./updates-mode.js";
import { fieldLine, renderPreviewDocument, textLine, type StyledLine } from "./preview-render.js";
import type { PreviewChrome } from "./preview-window.js";
import type { PreparedUpdates } from "./updates.js";

export function updateModePreviewLines(mode: UpdatesMode): readonly StyledLine[] {
  switch (mode.kind) {
    case "preview":
      return renderPreviewDocument(mode.prepared.document);
    case "manual":
      return [...appPlanLines(mode.plan), ...(mode.reason === undefined ? [] : [textLine(mode.reason)])];
    case "confirm-paths":
      return [
        textLine("Outside .agents/skills and .claude/skills:"),
        ...mode.prepared.nonCanonicalPaths.map(({ scope, path }) => fieldLine("Path:", `[${scope}] ${quoteText(path)}`)),
      ];
    default:
      return [];
  }
}

/**
 * What else confirming does besides applying: replaced local changes and external commands. Kept to
 * a bounded length so a narrow footer still fits the question after it; the warnings name every Skill.
 */
function previewEffects(prepared: PreparedUpdates): readonly string[] {
  const replaced = prepared.groups.flatMap((group) => group.applicable.filter((item) => group.overwriteShown.has(item.id)));
  const commands = prepared.document.sections.flatMap(({ items }) => items.flatMap(({ rows }) => rows.filter((row) => row.kind === "command"))).length;
  return [
    ...(replaced.length === 1 ? [`replaces ${replaced[0]!.selection.path}'s local changes`] : []),
    ...(replaced.length > 1 ? [`replaces local changes in ${replaced.length} Skills`] : []),
    ...(commands === 0 ? [] : [`runs ${commands} ${commands === 1 ? "command" : "commands"}`]),
  ];
}

export function updateModePreviewChrome(mode: UpdatesMode): PreviewChrome {
  switch (mode.kind) {
    case "preview": {
      const count = mode.prepared.applicable.length;
      if (count === 0) return { title: "Update batch preview", consequence: "Nothing can be applied.", cancel: "[Enter/Esc] back" };
      const action = mode.prepared.document.action;
      return { title: "Update batch preview", action, consequence: [...previewEffects(mode.prepared), `${action}? y/n`].join(" · ") };
    }
    case "manual":
      return { title: "Manual App update", action: "Check now", consequence: "Manual step done, check now? y/n" };
    case "confirm-paths":
      return { title: "Confirm replacing non-canonical locations", action: "Replace these paths", consequence: "Replace exactly these paths? y/n" };
    default:
      return { title: "Updates" };
  }
}
