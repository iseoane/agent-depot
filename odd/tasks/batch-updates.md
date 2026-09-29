# Batch skill updates

Ticket: `.scratch/agent-depot/issues/07-batch-updates.md`

Objective: Assess installed skills together and apply selected updates independently with safe preview and confirmation.

Constraints: Fixed/latest policies; unknown versions are not updateable; built-in copies change only through batch. Locally modified installations may be replaced only with explicit confirmation. External methods preview command, cwd, target and declared intended changes, warn about unverifiable side effects, and require confirmation. Preserve existing installations on failure where possible. Project and user-global scope remain independent.

TDD: not configured (existing task evidence and no project-level strict-TDD config); ordinary functional checks. Runner: `pnpm test:single -- tests/<file>.test.ts`; closure: `pnpm typecheck && pnpm test`.

Delivery: auto-chain authorized above ~400 accumulated authored lines, strategy `stacked-to-main` selected by user. Planned sequential slices: T1 `59d5bc7` (526 lines) → T2 `6ce609c` (760) → T3 `a90c7d7` (1,110) → T4 `123bc42` (673), measured as additions + deletions. Each depends on the previous; toward main means merge each before opening the next clean-diff PR, not four simultaneous PRs. A single cohesive split by work unit did not bring any slice under 400; recommend explicit `size:exception` approval before PR creation, not cosmetic line reduction. No push or PR authorized yet.

- [x] T1 Establish reliable version evidence and installation baselines; legacy unknown records remain safe. Route: delegated writer (multi-file). Check: focused tests passed, `pnpm typecheck` passed, full `pnpm test` passed (106/106), independent verifier confirmed persistence and snapshot coherence. Commit: `59d5bc7`.
- [x] T2 Assess available and unknown updates in one batch with all/subset selection and policy semantics. Route: delegated writer (multi-file). Check: independent verifier confirmed fail-closed selection and per-item isolation; `pnpm test` passed (120/120), `pnpm typecheck` passed. Commit: `6ce609c`.
- [x] T3 Apply selected updates transactionally, continue on independent failures, and preview/confirm external methods and overwrites. Route: delegated writer (multi-file). Check: independent verification of rollback, immutable confirmation, symlink and cwd safety, global persistence; `pnpm test` passed (129/129), `pnpm typecheck` passed. Commit: `a90c7d7`.
- [x] T4 Expose batch CLI, documentation and end-to-end coverage. Route: delegated writer (multi-file). Check: independent verifier confirmed unknown exclusion, failure continuation, persistence, numeric selection and injected filesystem; `pnpm test` passed (133/133), `pnpm typecheck` and `git diff --check` passed. Commit: `123bc42`.

Progress: T1–T4 implemented and independently verified. Pending: human approval for oversized PR slices; PR creation, push and merge remain unrequested. Full suite last passed 133/133 with typecheck and diff check. Next: seek size exception and delivery authorization if PRs are desired.
