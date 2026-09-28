# Adopt existing project skills

Objective: Implement issue 04 safely in known project locations (`.agents/skills`, `.claude/skills`), without replacing identical installations.

Scope: project installation and reusable comparison/adoption seam; no arbitrary path discovery or user-global installation. Preserve rollback safety and explicit consent for destructive or additional host-location actions. `--yes` alone must not silently authorize those actions.

TDD: requested where feasible; source: user implement instruction; runner: `pnpm test:single <test>` (builds first). Verification: `pnpm typecheck`, focused tests, `pnpm test` once at end. Review: code-review skill after implementation. Delivery: auto-chain authorized above 400 authored lines; chain strategy `stacked-to-main` selected by user. Forecast: approximately 350–500 authored lines; use coherent work units. First coherent slice is 506 lines and cannot be split further without separating tests from behavior; report size exception recommendation rather than compressing.

- [x] T1: Implement reusable tree comparison and safe adoption in known project paths, with focused tests. Route: delegated writer (multi-file write). Check: 2 skill-adoption tests, 18 project-installation tests, and typecheck passed. Commit: `1911b14`.
- [x] T2: Persist actual installation location and integrate CLI consent/conflict handling, with tests. Route: delegated writer (multi-file write). Check: 10 manifest, 22 CLI, 19 installation tests, typecheck passed; independent verifier ran prior to preview correction. Commit: pending.
- [ ] T3 (in progress): Run full suite, review since branch point, resolve findings and report. Route: delegated verification/review. Check: full suite and review. Commit: pending if fixes.

Progress: branch `feat/adopt-existing-skills` created from main. T1 committed at `1911b14` (506 changed lines including task document); stack authorized by user if above 400. Next: commit T2, run full suite and review.
