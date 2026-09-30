# Refresh the source before any preview that leads to a write

Status: Accepted (2026-09-30)

## Context

A Git Source can change between the moment a preview is shown and the moment it is applied. The CLI refreshes on `--yes`, so the applied content could differ from what was reviewed.

## Decision

Whenever a preview leads to a write, refresh the Source first and build the preview from the refreshed data. Confirming applies that same plan without a second refresh. The TUI does this for installs (and for Updates on entry and on `r`); the built-in Source is never refreshed. A failed refresh stops the operation before anything is written.

## Consequences

- The confirmed preview is exactly what is applied.
- Previews need network access and take longer.
- A refresh failure is reported per Source; Updates falls back to cached data and says so.
