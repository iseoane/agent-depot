# Batch skill updates

Ticket: `.scratch/agent-depot/issues/07-batch-updates.md`

Objective: Assess installed skills together and apply selected updates independently with safe preview and confirmation.

Constraints: Fixed/latest policies; unknown versions are not updateable; built-in copies change only through batch. Locally modified installations may be replaced only with explicit confirmation. External methods preview command, cwd, target and declared intended changes, warn about unverifiable side effects, and require confirmation. Preserve existing installations on failure where possible. Project and user-global scope remain independent.

TDD: not configured (existing task evidence and no project-level strict-TDD config); ordinary functional checks. Runner: `pnpm test:single -- tests/<file>.test.ts`; closure: `pnpm typecheck && pnpm test`.

Delivery: auto-chain authorized above ~400 accumulated authored lines, strategy `stacked-to-main` selected by user. Forecast: >400 authored lines across four work units. T1 currently ~508 changed lines (excluding task document), so first slice is T1. No push or PR authorized yet.

- [x] T1 Establish reliable version evidence and installation baselines; legacy unknown records remain safe. Route: delegated writer (multi-file). Check: focused tests passed, `pnpm typecheck` passed, full `pnpm test` passed (106/106), independent verifier confirmed persistence and snapshot coherence. Commit: `59d5bc7`.
- [x] T2 Assess available and unknown updates in one batch with all/subset selection and policy semantics. Route: delegated writer (multi-file). Check: independent verifier confirmed fail-closed selection and per-item isolation; `pnpm test` passed (120/120), `pnpm typecheck` passed. Commit: `6ce609c`.
- [x] T3 Apply selected updates transactionally, continue on independent failures, and preview/confirm external methods and overwrites. Route: delegated writer (multi-file). Check: independent verification of rollback, immutable confirmation, symlink and cwd safety, global persistence; `pnpm test` passed (129/129), `pnpm typecheck` passed. Commit: `a90c7d7`.
- [x] T4 Expose batch CLI, documentation and end-to-end coverage. Route: delegated writer (multi-file). Check: independent verifier confirmed unknown exclusion, failure continuation, persistence, numeric selection and injected filesystem; `pnpm test` passed (133/133), `pnpm typecheck` and `git diff --check` passed. Commit: pending recording.

Progress: T1–T4 implemented and independently verified. Pending: record final commit, review delivery slices and decide whether to open PRs (not authorized yet).
