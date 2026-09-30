# Back up skills before explicit overwrite

Goal: Warn of existing-content conflicts before install confirmation and support explicit `--overwrite --yes` with a persistent recoverable copy of the original skill. Never replace the user's nine divergent global skills as part of implementation.

Approved contract: both project and user-global scopes; --yes alone cannot overwrite; already managed entries use update apply; reject links/unsafe/ambiguous targets; retain successful backup without automatic pruning and display its location; restore original on install or state-save failure. Make destination inspection race-safe.
TDD: not explicitly enabled; ordinary focused and full checks via pnpm.
Delivery: one large review unit explicitly accepted by user after ~1,391 authored lines were disclosed; branch feat/backup-before-skill-overwrite. No commit authorized yet. Residual limits: portable filesystem cannot offer cross-process atomic compare-and-swap; abrupt process termination may need manual backup recovery; Windows/case-insensitive aliases have not been validated on Windows.

- [x] Task 1 (delegated writer): Read-only collision classification and pre-confirmation preview/error with exact --overwrite --yes guidance, both scopes; tests. Evidence: CLI 49 passed, project-installation 24 passed, typecheck passed; subsequent full suite 176 passed. No commit authorized yet.
- [x] Task 2 (delegated writer): Implement explicit overwrite transaction with persistent backup and rollback across state persistence; safety/race tests, docs. Evidence: independent verifier `pnpm test` 176 passed, `pnpm typecheck`, `pnpm lint`, `git diff --check` passed. No commit authorized yet.
