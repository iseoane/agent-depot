import { Box, Text } from "ink";

import type { BulkHostPlan, BulkUninstallPlan, SkippedTarget } from "./bulk-actions.js";
import type { ManageMode } from "./manage-actions.js";
import { ChecklistLines, PreviewConfirm, PreviewLines } from "./panel-parts.js";
import { theme } from "./theme.js";

const plural = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

function SkippedLines({ skipped }: { readonly skipped: readonly SkippedTarget[] }) {
  return (
    <>
      {skipped.map(({ id, label, reason }) => <Text key={id} color={theme.warning}>Skipped {label}: {reason}</Text>)}
    </>
  );
}

interface PlanEntry {
  readonly id: string;
  readonly label: string;
  readonly lines: readonly string[];
  readonly warnFirst: boolean;
}

/** One block per planned item, the skipped ones, then the y/n question. */
function PlanPreview({ entries, skipped, question }: {
  readonly entries: readonly PlanEntry[];
  readonly skipped: readonly SkippedTarget[];
  readonly question: string;
}) {
  return (
    <Box flexDirection="column">
      {entries.map((entry) => (
        <Box key={entry.id} flexDirection="column">
          <Text color={theme.group}>{entry.label}</Text>
          <PreviewLines lines={entry.lines} warnFirst={entry.warnFirst} />
        </Box>
      ))}
      <SkippedLines skipped={skipped} />
      <Text>{question}</Text>
    </Box>
  );
}

function UninstallPreview({ plan }: { readonly plan: BulkUninstallPlan }) {
  const entries = plan.items.map((item): PlanEntry => ({
    id: item.id,
    label: item.label,
    lines: item.kind === "managed" ? item.prepared.plan.preview : item.prepared.preview,
    warnFirst: item.kind === "unmanaged",
  }));
  return <PlanPreview entries={entries} skipped={plan.skipped} question={`Uninstall ${plural(plan.items.length)}? y/n`} />;
}

function HostsPreview({ plan }: { readonly plan: BulkHostPlan }) {
  const entries = plan.items.map((item): PlanEntry => ({ id: item.id, label: item.label, lines: item.prepared.preview, warnFirst: false }));
  return <PlanPreview entries={entries} skipped={plan.skipped} question={`Add hosts to ${plural(plan.items.length)}? y/n`} />;
}

/** Renders the prompt of a manage mode: host lists, previews and confirmations. */
export function ManagePanel({ mode }: { readonly mode: ManageMode }) {
  switch (mode.kind) {
    case "remove-scope":
      return <Text>Uninstall {mode.skill.name} (hosts: {mode.hosts.join(", ")}): 1 all hosts  2 choose hosts  (Esc cancel)</Text>;
    case "hosts-add":
    case "hosts-remove":
      return (
        <Box flexDirection="column">
          <Text>
            {mode.kind === "hosts-add" ? "Add hosts to" : "Remove hosts from"} {mode.skill.name}. Host (space/1-{mode.choices.length} toggle, j/k move, Enter continue, Esc cancel):
          </Text>
          <ChecklistLines choices={mode.choices} cursor={mode.cursor} isSelected={(host) => mode.selected.includes(host)} keyOf={(host) => host} label={(host) => host} />
        </Box>
      );
    case "confirm-host-add":
      return <PreviewConfirm lines={mode.prepared.preview} question={`Add hosts to ${mode.skill.name}? y/n`} />;
    case "confirm-host-exposure":
      return (
        <Text color={theme.warning}>
          Adding hosts exposes the installed {mode.skill.name} to more hosts and needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    case "confirm-host-remove":
      return <PreviewConfirm lines={mode.prepared.preview} question={`Remove hosts from ${mode.skill.name}? y/n`} />;
    case "confirm-uninstall":
      return <PreviewConfirm lines={mode.prepared.plan.preview} question={`Uninstall ${mode.skill.name}? y/n`} />;
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
    case "confirm-unmanaged":
      return <PreviewConfirm lines={mode.prepared.preview} question={`Remove ${mode.group.name}? y/n`} warnFirst />;
    case "bulk-hosts":
      return (
        <Box flexDirection="column">
          <Text>Add hosts to {plural(mode.targets.length)}. Host (space/1-{mode.choices.length} toggle, j/k move, Enter continue, Esc cancel):</Text>
          <ChecklistLines choices={mode.choices} cursor={mode.cursor} isSelected={(host) => mode.selected.includes(host)} keyOf={(host) => host} label={(host) => host} />
          <SkippedLines skipped={mode.skipped} />
        </Box>
      );
    case "confirm-bulk-uninstall":
      return <UninstallPreview plan={mode.plan} />;
    case "confirm-bulk-hosts":
      return <HostsPreview plan={mode.plan} />;
    case "confirm-bulk-exposure":
      return (
        <Text color={theme.warning}>
          Adding hosts exposes the installed {mode.plan.items.map((item) => item.label).join(", ")} to more hosts and needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    case "busy":
      return <Text>{mode.label}</Text>;
  }
}
