# Node 24 LTS minimum

Status: Accepted (2026-09-30)

## Context

Ink 7 requires Node >= 22. Node 24 was the Active LTS release when the TUI was added.

## Decision

Raise `engines.node` to `>=24` and `@types/node` to `^24`.

## Consequences

- Users on older Node versions must upgrade, including for CLI-only use.
- One supported runtime line keeps CI and docs simple.
- The README states the requirement.
