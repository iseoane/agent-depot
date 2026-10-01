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

### Review corrections

- App checks now run independently from Skill scope loads; failures have an Apps
  error line without hiding Skill rows (and vice versa). CLI loading is unchanged.
- Declining or unmounting a manual prompt settles the batch and clears pending
  update evidence without changing tracking. Spawn-fallback reasons remain visible
  in both the manual prompt and cancellation result.
- Recipe-change regression confirms execution is refused and tracking preserved.
- Five regressions failed before the fixes; the recipe-change safety test already
  passed. Final `pnpm typecheck`, `pnpm lint`, `pnpm test`: 624 passed, 0 failed.
- Rollback boundary: this review correction's App cancellation operation, Updates
  changes, regression tests and notes; no CLI workflow changes.

### CLI re-review corrections

- CLI checks Apps independently with a category-specific error; `loadUpdates`
  now accepts/returns Skill data only. Skill listing failure retains App check
  output, and App inventory failure retains Skill assessment and application.
- Both CLI regression tests failed before implementation and now pass.
- Focused `tests/app-updates.test.ts`: 21 passed; final typecheck/lint passed;
  full suite: 626 passed, 0 failed. Runtime boundary: public CLI with temporary
  per-user files, injected executable resolution, runner and HTTP fetch.
- Rollback boundary: CLI check separation, Skill-only update-flow types, the two
  CLI regressions and these notes. TUI row/signature formatting is independent.
