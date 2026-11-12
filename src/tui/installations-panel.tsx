import { Box } from "ink";
import { Text } from "./safe-text.js";

import { adoptionPreview } from "./adoption-actions.js";
import { HOST_CHOICES } from "./catalog-actions.js";
import type { InstallationsMode } from "./installations-mode.js";
import { ManagePanel } from "./manage-panel.js";
import { DecisionPrompt, HostChecklist, PagedPreview } from "./panel-parts.js";
import { usePreviewGeometry } from "./preview-window.js";
import { theme } from "./theme.js";

/** An adoptable preview with the shared footer; the view shows it alone so no tree rows count against its height. */
export function AdoptionConfirmPanel({ mode }: { readonly mode: Extract<InstallationsMode, { readonly kind: "confirm" }> }) {
  const { lines, chrome } = adoptionPreview(mode);
  return <PagedPreview lines={lines} viewport={usePreviewGeometry()(lines, mode.cursor, chrome)} />;
}

/** The prompt of the adoption and manage modes; browsing shows nothing. */
export function ModePanel({ mode }: { readonly mode: InstallationsMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "pick":
      return (
        <Box flexDirection="column">
          <Text>Adopt {mode.entry.name}: several Source Skills match. j/k move, Enter select, Esc cancel:</Text>
          {mode.candidates.map((skill, position) => (
            <Text key={`${skill.sourceId}:${skill.path}`}>{position === mode.cursor ? "> " : "  "}{skill.path}  {skill.sourceId}</Text>
          ))}
        </Box>
      );
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Adopt {mode.entry.name} as {mode.skill.path}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          <HostChecklist choices={HOST_CHOICES} cursor={mode.cursor} selected={mode.selected} />
        </Box>
      );
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "confirm":
      return mode.adoption.verdict.adoptable ? (
        <AdoptionConfirmPanel mode={mode} />
      ) : (
        <Box flexDirection="column">
          <Text color={theme.error}>{mode.adoption.verdict.reason}</Text>
          <Text>Enter/Esc to go back</Text>
        </Box>
      );
    case "confirm-exposure":
      return (
        <Text color={theme.warning}>
          Adopting {mode.entry.name} adds the missing Host location and exposes it to more hosts; this needs separate confirmation (CLI: --confirm-additional-host). <DecisionPrompt>Confirm?</DecisionPrompt>
        </Text>
      );
    default:
      return <ManagePanel mode={mode} />;
  }
}
