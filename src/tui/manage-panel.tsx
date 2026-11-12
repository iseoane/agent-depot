import { Box } from "ink";
import { Text } from "./safe-text.js";

import { AppPanel } from "./app-actions.js";
import { PackagePanel } from "./package-actions.js";
import type { SkippedTarget } from "./bulk-actions.js";
import { pagedConfirmPreview, type ManageMode, type PagedConfirmMode } from "./manage-actions.js";
import { ChecklistLines, DecisionPrompt, HostChecklist, PagedPreview, Working } from "./panel-parts.js";
import { usePreviewGeometry } from "./preview-window.js";
import { theme } from "./theme.js";

const plural = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

function SkippedLines({ skipped }: { readonly skipped: readonly SkippedTarget[] }) {
  return (
    <>
      {skipped.map(({ id, label, reason }) => <Text key={id} color={theme.warning}>Skipped {label}: {reason}</Text>)}
    </>
  );
}

/** A Skill confirmation with the shared footer; the view shows it alone so no tree rows count against its height. */
export function PagedConfirmPanel({ mode }: { readonly mode: PagedConfirmMode }) {
  const { lines, styled, chrome } = pagedConfirmPreview(mode);
  return <PagedPreview chrome={chrome} lines={lines} styled={styled} viewport={usePreviewGeometry()(lines, mode.cursor, chrome)} />;
}

/** Renders the prompt of a manage mode: host lists, previews and confirmations. */
export function ManagePanel({ mode }: { readonly mode: ManageMode }) {
  switch (mode.kind) {
    case "app-busy":
    case "app-approve":
    case "app-hosts":
    case "app-confirm":
    case "app-manual":
      return <AppPanel mode={mode} />;
    case "package-approve":
    case "package-confirm":
    case "package-forget":
      return <PackagePanel mode={mode} />;
    case "remove-scope":
      return <Text>Uninstall {mode.skill.name} (hosts: {mode.hosts.join(", ")}): 1 all hosts  2 choose hosts  (Esc cancel)</Text>;
    case "hosts-add":
    case "hosts-remove":
      return (
        <Box flexDirection="column">
          <Text>
            {mode.kind === "hosts-add" ? "Add hosts to" : "Remove hosts from"} {mode.skill.name}. Host (space/1-{mode.choices.length} toggle, j/k move, Enter continue, Esc cancel):
          </Text>
          <HostChecklist choices={mode.choices} cursor={mode.cursor} selected={mode.selected} />
        </Box>
      );
    case "confirm-host-add":
    case "confirm-host-remove":
    case "confirm-uninstall":
    case "confirm-unmanaged":
    case "confirm-bulk-uninstall":
    case "confirm-bulk-hosts":
      return <PagedConfirmPanel mode={mode} />;
    case "confirm-host-exposure":
      return (
        <Text color={theme.warning}>
          Adding hosts exposes the installed {mode.skill.name} to more hosts and needs separate confirmation (CLI: --confirm-additional-host). <DecisionPrompt>Confirm?</DecisionPrompt>
        </Text>
      );
    case "unmanaged-scope":
      return <Text>Remove {mode.group.name} ({mode.group.locations.length} locations): 1 all locations  2 choose locations  (Esc cancel)</Text>;
    case "unmanaged-pick":
      return (
        <Box flexDirection="column">
          <Text>Remove locations of {mode.group.name}. Location (space/1-{mode.group.locations.length} toggle, j/k move, Enter continue, Esc cancel):</Text>
          <ChecklistLines
            choices={mode.group.locations}
            cursor={mode.cursor}
            isSelected={(location) => mode.selected.includes(location.path)}
            keyOf={(location) => location.path}
            label={(location) => `${location.path}${location.linkTarget === undefined ? "" : `  symlink → ${location.linkTarget}`}`}
          />
        </Box>
      );
    case "bulk-hosts":
      return (
        <Box flexDirection="column">
          <Text>Add hosts to {plural(mode.targets.length)}. Host (space/1-{mode.choices.length} toggle, j/k move, Enter continue, Esc cancel):</Text>
          <HostChecklist choices={mode.choices} cursor={mode.cursor} selected={mode.selected} />
          <SkippedLines skipped={mode.skipped} />
        </Box>
      );
    case "confirm-bulk-exposure":
      return (
        <Text color={theme.warning}>
          Adding hosts exposes the installed {mode.plan.items.map((item) => item.label).join(", ")} to more hosts and needs separate confirmation (CLI: --confirm-additional-host). <DecisionPrompt>Confirm?</DecisionPrompt>
        </Text>
      );
    case "busy":
      return (
        <Box flexDirection="column">
          <Working label={mode.label} since={mode.startedAt} />
          {(mode.done ?? []).length > 0 ? <Text color={theme.muted}>{mode.done!.length} finished</Text> : null}
        </Box>
      );
  }
}
