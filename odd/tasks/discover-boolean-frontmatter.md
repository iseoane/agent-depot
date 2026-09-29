# Discover skills with optional boolean frontmatter

Objective: Fix discover so valid name and description survive optional boolean metadata; discovery remains read-only and never executes metadata or commands. User requests one separate commit from ticket 06.

Branch: `fix/discover-boolean-frontmatter` from main. TDD mode not configured; targeted regression-first debugging required. Runner: `pnpm test:single -- tests/skill-discovery.test.ts`, `pnpm test:single -- tests/cli.test.ts`, `pnpm typecheck`, `pnpm test`.

- [x] D1 (delegated): Reproduce omission with minimal unit and CLI tests, then fix frontmatter acceptance without executing optional fields. Check: RED unit 7 passed/1 failed; GREEN unit 8/8, CLI 27/27, typecheck and suite 90/90 passed. Surfaces: `src/skill-discovery.ts`, `tests/skill-discovery.test.ts`, `tests/cli.test.ts`. Commit: pending.
- [x] D2: Independently verify behavior and commit separately; keep unrelated ticket 06 untouched. Check: independent verifier confirmed unit 8/8, CLI 27/27, typecheck, full suite 90/90, diff check; no metadata or command execution. Commit: see branch HEAD.

Forecast: <200 changed lines, single PR slice. Next: one separate bugfix commit, no push or PR.
