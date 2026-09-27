# Install project-scoped Skills

Status: ready-for-agent
Blocked by: 02 Discover Skills from selected Sources

## What to build

Let users install selected compatible Skills for chosen Hosts in project scope. Record the selection sufficiently to resolve it on a fresh machine. Apply the canonical Host mapping and Claude symlink behavior and failure policy confirmed for V1.

## Acceptance criteria

- Users can select compatible Skills and chosen Hosts for a project-scoped installation.
- Incompatible Skills are not installed for a selected Host.
- Project selections are recorded with enough Source and Skill identity to resolve them on a fresh machine.
- New project-scoped installations use the canonical Host mapping.
- When Claude is selected, its canonical directory is exposed through the required symlink behavior.
- If the required Claude symlink cannot be created, the operation stops with actionable guidance and does not create a duplicate managed copy.
- Any external installation method supplied by a Skill Source is previewed with the intended changes and requires explicit confirmation before execution.
- Project-scoped installations are distinct from user-global installations.
