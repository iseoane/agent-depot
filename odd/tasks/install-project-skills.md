# Install project skills (issue 03)

Objective: Install selected portable skills for chosen project hosts, preserving reproducible project selection and refusing unsafe external methods.
Problem: Discovery exists, but no project install or manifest operation exists.
Why: A clone must resolve selected skills without a pre-existing global catalog.
Scope: Issue `.scratch/agent-depot/issues/03-install-project-skills.md`; no global installation, adoption, or updates.
Constraints: Source commands only from explicit structured metadata (user approved); preview and explicit confirmation before execution. Do not overwrite existing paths; no implicit command discovery. Keep tests/docs with behavior. TDD mode: unknown (no configured TDD policy found); ordinary behavior-focused tests. Runner: `pnpm test:single tests/<file>.test.ts`, full `pnpm test`, `pnpm typecheck`.
Delivery: auto-chain allowed by user if needed; chain strategy unresolved if >400 authored lines. Forecast 550–850 authored lines, generated excluded. GitHub PR requires approved issue; local issue 03 exists, remote issue #3 absent.

## Tasks
- [x] I03-1: Implement project manifest with validated source/skill/version/hosts identity and tests. Route: delegated writer (multi-file). Focused test 9/9 and typecheck passed (writer and independent verifier); runtime harness N/A (persistence API); rollback: manifest module and tests. Commit: pending.
- [ ] I03-2: Safely retrieve full selected skill trees from built-in/Git sources, with tests. Route: delegated writer (multi-file). Check: focused test, typecheck; commit pending.
- [ ] I03-3: Implement compatible host install, Claude symlink and rollback/conflict behavior with tests. Route: delegated writer (multi-file). Check: focused test, typecheck; commit pending.
- [ ] I03-4: Wire CLI selection, explicit structured-method preview/confirmation, docs, tests. Route: delegated writer (multi-file). Check: focused/full tests and typecheck; commit pending.

## Progress
Exploration completed read-only; dependency issue 02 implemented. I03-1 verified. Next: I03-2.
