# 08: Exclude App-owned skills from the unmanaged inventory

**What to build:** The recipe's `skills` names or globs mark skills that the App installs itself. They are excluded from the unmanaged-skill adopt and remove flows, both in the CLI and in the Unmanaged group of the TUI.

**Blocked by:** 02.

**Status:** completed

- [x] A skill matching any applicable recipe's `skills` entry is not listed as unmanaged and cannot be adopted or removed through that flow.
- [x] Agent Depot verifies nothing about those paths.

## Implementation evidence

- Shared declarative filter: `src/app-owned-skills.ts`; inventory filters before
  path inspection, removal/adoption recheck ownership in core write operations.
- Unapproved applicable recipes count; strict name glob semantics and degradation
  policy are recorded in ADR 0007 (Ticket 08).
- Focused checks: inventory (18 tests), CLI/core ownership (3 tests), TUI unmanaged
  (15 tests). CLI tests use real built-in Skill content and isolated user homes.
- Runtime boundary: CLI listing/adopt/remove and rendered TUI Unmanaged group are
  exercised by the focused integration tests; no external commands are needed.
- Rollback boundary: remove the owned-Skill filter and its inventory/write/UI
  wiring with these tests and ADR section; App lifecycle flows are unchanged.

- Final verification: `pnpm typecheck`, `pnpm lint`, `pnpm test`: 634 passed.
