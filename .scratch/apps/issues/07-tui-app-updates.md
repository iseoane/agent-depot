# 07: TUI: Apps in the Updates batch

**What to build:** App rows join the Updates batch with the same statuses as skills. `r` re-checks, and Enter previews and applies the selected App updates.

**Blocked by:** 05, 06.

**Status:** completed

- [x] Apps whose version cannot be checked appear in the folded "cannot be checked" row.
- [x] A mixed selection of skills and Apps applies both kinds, and failures are summarised per item.

## Verification

- TDD tracer: App row/preview test failed with “No installations” before implementation.
- Focused public TUI harness: 44 Updates tests passed before the final spawn-fallback slice.
- Final verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` — 618 passed, 0 failed.
- Direct two-axis review against `3f63691`: no outstanding Standards or Spec findings.
  Parallel sub-agent review unavailable in this harness.
- Rollback boundary: `src/tui/updates*`, accompanying Updates tests, and ticket/spec notes.
  Shared App/Skill core operations remain unchanged.
