# Batch skill updates

Ticket: `.scratch/agent-depot/issues/07-batch-updates.md`

Objective: Assess installed skills together and apply selected updates independently with safe preview and confirmation.

Constraints: Fixed/latest policies; unknown versions are not updateable; built-in copies change only through batch. Locally modified installations may be replaced only with explicit confirmation. External methods preview command, cwd, target and declared intended changes, warn about unverifiable side effects, and require confirmation. Preserve existing installations on failure where possible. Project and user-global scope remain independent.

TDD: not configured (existing task evidence and no project-level strict-TDD config); ordinary functional checks. Runner: `pnpm test:single -- tests/<file>.test.ts`; closure: `pnpm typecheck && pnpm test`.

Delivery: auto-chain authorized above ~400 accumulated authored lines, strategy `stacked-to-main` selected by user. Forecast: >400 authored lines across four work units. T1 currently ~508 changed lines (excluding task document), so first slice is T1. No push or PR authorized yet.

- [x] T1 Establish reliable version evidence and installation baselines; legacy unknown records remain safe. Route: delegated writer (multi-file). Check: focused tests passed, `pnpm typecheck` passed, full `pnpm test` passed (106/106), independent verifier confirmed persistence and snapshot coherence. Commit: pending recording.
- [ ] T2 Assess available and unknown updates in one batch with all/subset selection and policy semantics. Route: delegated writer (multi-file). Check: focused batch tests. Commit: pending.
- [ ] T3 Apply selected updates transactionally, continue on independent failures, and preview/confirm external methods and overwrites. Route: delegated writer (multi-file). Check: focused update tests. Commit: pending.
- [ ] T4 Expose batch CLI, documentation and end-to-end coverage. Route: delegated writer (multi-file). Check: CLI tests, typecheck, full suite. Commit: pending.

Progress: T1 verified; T2 next. Product decisions recorded above. Next: implement and verify T2. Pending checks: update-specific tests, final full suite, PR slice review.
