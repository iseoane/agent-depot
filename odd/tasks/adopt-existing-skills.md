# Adopt existing project skills

Objective: Implement issue 04 safely in known project locations (`.agents/skills`, `.claude/skills`), without replacing identical installations.

Scope: project installation and reusable comparison/adoption seam; no arbitrary path discovery or user-global installation. Preserve rollback safety and explicit consent for destructive or additional host-location actions. `--yes` alone must not silently authorize those actions.

TDD: requested where feasible; source: user implement instruction; runner: `pnpm test:single <test>` (builds first). Verification: `pnpm typecheck`, focused tests, `pnpm test` once at end. Review: code-review skill after implementation. Delivery: auto-chain authorized above 400 authored lines; chain strategy pending if threshold crossed. Forecast: approximately 350–500 authored lines; use coherent work units.

- [ ] T1 (in progress): Implement reusable tree comparison and safe adoption in known project paths, with focused tests. Route: delegated writer (multi-file write). Check: focused installation tests and typecheck. Commit: pending.
- [ ] T2: Persist actual installation location and integrate CLI consent/conflict handling, with tests. Route: delegated writer (multi-file write). Check: focused manifest and CLI tests, typecheck. Commit: pending.
- [ ] T3: Run full suite, review since branch point, resolve findings and report. Route: delegated verification/review. Check: full suite and review. Commit: pending if fixes.

Progress: branch `feat/adopt-existing-skills` created from main. Next: implement T1.
