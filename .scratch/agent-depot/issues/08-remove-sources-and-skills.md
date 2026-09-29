# Replace or remove Sources safely

Status: completed
Blocked by: 04 Adopt existing Skills safely, 05 Install user-global Skills, and 06 Run user-provided methods safely

## What to build

When a Source is removed, show its dependent installed Skills and let users keep all, uninstall selected Skills, or uninstall all dependent Skills. Kept Skills remain tracked. Require confirmation before removing Skills. To change a Source URL, add a new Source, explicitly migrate selections, and then remove the old Source without silently rewriting selected identities.

## Acceptance criteria

- Removing a Source shows the installed Skills that depend on it.
- Users can keep all dependent Skills when removing a Source.
- Users can uninstall a selected subset of dependent Skills when removing a Source.
- Users can uninstall all dependent Skills when removing a Source.
- Kept Skills remain tracked after their Source is removed.
- Removing Skills requires explicit user confirmation.
- Changing a Source URL requires adding a new Source rather than mutating the old one.
- Users explicitly migrate selections before the old Source is removed.
- Selected Source or Skill identities are never silently rewritten during replacement.
