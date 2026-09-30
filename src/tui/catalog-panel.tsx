import { Box, Text } from "ink";

import { describeSkills, HOST_CHOICES, SCOPE_CHOICES, type ActionMode } from "./catalog-actions.js";
import { skillKey } from "./catalog-tree.js";
import { ChecklistLines, PreviewLines } from "./panel-parts.js";
import { theme } from "./theme.js";

/** The prompt of the install flow; browsing shows nothing. */
export function ActionPanel({ mode }: { readonly mode: ActionMode }) {
  switch (mode.kind) {
    case "browse":
      return null;
    case "host":
      return (
        <Box flexDirection="column">
          <Text>Install {describeSkills(mode.skills)}. Host (space/1-4 toggle, j/k move, Enter continue, Esc cancel):</Text>
          <ChecklistLines choices={HOST_CHOICES} cursor={mode.cursor} isSelected={(host) => mode.selected.includes(host)} keyOf={(host) => host} label={(host) => host} />
        </Box>
      );
    case "scope":
      return <Text>Scope: {SCOPE_CHOICES.map((scope, i) => `${i + 1} ${scope}`).join("  ")}  (Esc cancel)</Text>;
    case "version":
      return <Text>Version: 1 latest  2 fixed  (Esc cancel)</Text>;
    case "fixed":
      return <Text>Fixed version: {mode.value}_  (Enter confirm, Esc cancel)</Text>;
    case "confirm-install": {
      const ready = mode.items.filter((item) => item.prepared !== undefined);
      const single = mode.items.length === 1;
      return (
        <Box flexDirection="column">
          {mode.items.map(({ skill, prepared, error }) =>
            prepared === undefined ? (
              <Text key={skillKey(skill)} color={theme.error}>Cannot install {skill.name}: {error}</Text>
            ) : (
              <Box key={skillKey(skill)} flexDirection="column">
                {single ? null : <Text color={theme.group}>{skill.name}</Text>}
                <PreviewLines lines={prepared.preview} />
              </Box>
            ))}
          {ready.some((item) => item.prepared?.runsExternalCommand) ? <Text color={theme.warning}>This install runs an external command (see above).</Text> : null}
          <Text>Install {describeSkills(ready.map((item) => item.skill))}? y/n</Text>
        </Box>
      );
    }
    case "confirm-exposure": {
      const names = mode.items.filter((item) => item.prepared?.additionalHostExposure).map((item) => item.skill.name);
      return (
        <Text color={theme.warning}>
          {names.length === 1 ? `An identical ${names[0]} already exists` : `Identical copies of ${names.join(", ")} already exist`}; adding the missing Host location needs separate confirmation (CLI: --confirm-additional-host). Confirm? y/n
        </Text>
      );
    }
    case "busy":
      return <Text>{mode.label}</Text>;
  }
}
