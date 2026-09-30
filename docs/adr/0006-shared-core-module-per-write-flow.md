# A shared core module per write flow

Status: Accepted (2026-09-30)

## Context

The CLI and the TUI must do the same thing for the same operation, and the TUI must not parse CLI output.

## Decision

Each write flow lives in one core module that returns plans, previews and results, and both front ends call it: install (`src/skill-install.ts`), removal (`src/skill-removal.ts`), hosts (`src/skill-hosts.ts`), update (`src/update-flow.ts`), and unmanaged removal (`src/unmanaged-removal.ts`). The front ends only collect input, show the preview and ask for confirmation.

## Consequences

- Previews, safety checks and rechecks cannot drift between CLI and TUI.
- Extractions were refactors with CLI output unchanged and existing tests green.
- New flows start in a core module, not in a view.
