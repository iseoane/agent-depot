import { Box, Text } from "ink";

import type { ManageMode } from "./manage-actions.js";
import { theme } from "./theme.js";

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
          {mode.choices.map((host, position) => (
            <Text key={host}>
              {position === mode.cursor ? "> " : "  "}[{mode.selected.includes(host) ? "x" : " "}] {position + 1} {host}
            </Text>
          ))}
        </Box>
      );
    case "confirm-host-add":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          <Text>Add hosts to {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "confirm-host-exposure":
      return (
        <Text color={theme.warning}>
          Adding hosts exposes the installed {mode.skill.name} to more hosts and needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    case "confirm-host-remove":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          <Text>Remove hosts from {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "confirm-uninstall":
      return (
        <Box flexDirection="column">
          {mode.prepared.plan.preview.map((line, position) => <Text key={position}>{line}</Text>)}
          <Text>Uninstall {mode.skill.name}? y/n</Text>
        </Box>
      );
    case "unmanaged-scope":
      return <Text>Remove {mode.group.name} ({mode.group.locations.length} locations): 1 all locations  2 choose locations  (Esc cancel)</Text>;
    case "unmanaged-pick":
      return (
        <Box flexDirection="column">
          <Text>Remove locations of {mode.group.name}. Location (space/1-{mode.group.locations.length} toggle, j/k move, Enter continue, Esc cancel):</Text>
          {mode.group.locations.map((location, position) => (
            <Text key={location.path}>
              {position === mode.cursor ? "> " : "  "}[{mode.selected.includes(location.path) ? "x" : " "}] {position + 1} {location.path}
              {location.linkTarget === undefined ? "" : `  symlink → ${location.linkTarget}`}
            </Text>
          ))}
        </Box>
      );
    case "confirm-unmanaged":
      return (
        <Box flexDirection="column">
          {mode.prepared.preview.map((line, position) => <Text key={position} color={position === 0 ? theme.warning : undefined}>{line}</Text>)}
          <Text>Remove {mode.group.name}? y/n</Text>
        </Box>
      );
    case "busy":
      return <Text>{mode.label}</Text>;
  }
}
