# Run user-provided methods safely

Status: ready-for-agent
Blocked by: 03 Install project-scoped Skills and 05 Install user-global Skills

## What to build

Let users configure a needed Skill installation or update method as an executable plus arguments. Methods must not use a shell, contain secrets, or have OS-specific variants. Before running a method, show the exact command and intended changes and require explicit confirmation.

## Acceptance criteria

- Users can configure a needed Skill install or update method as an executable with arguments.
- Configured methods do not use a shell.
- Configured methods contain no secrets.
- Configured methods have no OS-specific variants.
- The exact command is shown before execution.
- The intended changes are shown before execution.
- Explicit user confirmation is required before a configured method runs.
