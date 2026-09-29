# Adopt existing Skills safely

Status: completed
Blocked by: 03 Install project-scoped Skills

## What to build

Let users adopt existing Skills without replacing or moving them when their content is identical to the selected Skill. Track the actual location. Treat different content with the same name as a conflict, require explicit confirmation before overwriting, and require confirmation before moving an adopted Skill or exposing it at another Host location. Make this shared adoption behavior available to later scopes.

## Acceptance criteria

- An existing Skill with identical content is adopted in place without reinstalling, replacing, or moving it.
- The adopted Skill's actual location is tracked.
- Different content with the same name is reported as a conflict.
- A conflicting Skill is not overwritten without explicit user confirmation.
- Moving an adopted Skill requires explicit user confirmation.
- Adding another Host location for an adopted Skill requires explicit user confirmation.
- The adoption behavior can be reused by later installation scopes.
