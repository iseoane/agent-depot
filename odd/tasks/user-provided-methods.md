# User-provided installation methods

Ticket: `.scratch/agent-depot/issues/06-user-provided-methods.md`

Objective: Allow project and user-global skill selections to store portable, shell-free install/update argv methods; execute configured install methods only after command and intended changes are previewed and explicitly confirmed. Update execution belongs to the future update workflow.

Constraints: No secret literals in configuration (document prohibition and reject obvious credential patterns; exhaustive detection is not possible). One cross-platform command per method, no platform variants. Preserve source-method behavior, prefer explicitly configured method over source method. No shell execution. Work on `feat/user-provided-methods`; user authorized stacked PRs if review budget exceeds ~400 changed lines, but not publishing without further decision.

TDD: not configured; use focused tests, typecheck, full suite. Runner: `pnpm test:single -- tests/<file>.test.ts`, `pnpm typecheck`, `pnpm test`.

Forecast: ~350–450 changed lines; delivery strategy auto-chain, stacked-to-main if >400, one cohesive slicing pass.

- [x] T1 (delegated): Validate and persist user methods for project and global selections. Check: manifest tests 12/12, source tests 14/14, typecheck passed. Surfaces: `src/project-manifest.ts`, `src/sources.ts`, `tests/project-manifest.test.ts`, `tests/sources.test.ts`. Commit: `23ed4bb`.
- [x] T2 (delegated): Resolve configured install method, preview exact command and intended changes, confirm before execution, document limits; add direct global/project `--method`. Check: CLI tests 31/31, typecheck, full suite 96/96 passed. Surfaces: `src/cli.ts`, `tests/cli.test.ts`, `README.md`. Commits: `cfdbc3f`, `0d1dba1`.
- [x] T3 (delegated): Address spec review validation bypasses for `dash`, credential-bearing `cwd`, and drive-qualified `cwd`. Check: manifest tests 13/13, source tests 14/14, typecheck and full suite 97/97 passed. Surfaces: `src/project-manifest.ts`, `tests/project-manifest.test.ts`, `tests/sources.test.ts`. Commit: `382ecc8`.

Progress: T1–T3 committed. Current diff versus main: 666 changed lines (590 additions, 76 deletions), so cohesive dependent slices are needed; no PR published. Review: initial spec review caught global configuration and three validation bypasses, all corrected; source-level standards review found pre-existing naming/abstraction issues and existing duplicated direct install flow, not introduced by this change. Final suite 97/97 and typecheck passed. Independent verification pending. Next: independent verification and prepare local stacked branches without publishing.
