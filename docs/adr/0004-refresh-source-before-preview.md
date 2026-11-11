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

## Amendment: reuse a recent refresh in the TUI (2026-11-11, I0031)

The TUI keeps an in-memory refresh session per process (`src/source-refresh-session.ts`). At startup it refreshes the registered Git Sources in the background, two at a time, without credential prompts and with a 60 s limit per Git command.

- A preview or an Updates check reuses a successful refresh this same process made less than one hour ago instead of refreshing again. A refresh still in flight is joined, not repeated.
- A Source that failed to refresh, or was never refreshed in this process, is always refreshed before the preview.
- `r` in Sources and Updates always forces a new refresh.
- A failed refresh still stops a preview before anything is written.
- The CLI is unchanged: it refreshes every time.

The session writes no files; the freshness record dies with the process.
