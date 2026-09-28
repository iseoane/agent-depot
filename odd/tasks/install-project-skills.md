# Install project skills (issue 03)

Objective: Install selected portable skills for chosen project hosts, preserving reproducible project selection and refusing unsafe external methods.
Problem: Discovery exists, but no project install or manifest operation exists.
Why: A clone must resolve selected skills without a pre-existing global catalog.
Scope: Issue `.scratch/agent-depot/issues/03-install-project-skills.md`; no global installation, adoption, or updates.
Constraints: Source commands only from explicit structured metadata (user approved); preview and explicit confirmation before execution. Do not overwrite existing paths; no implicit command discovery. Keep tests/docs with behavior. TDD mode: unknown (no configured TDD policy found); ordinary behavior-focused tests. Runner: `pnpm test:single tests/<file>.test.ts`, full `pnpm test`, `pnpm typecheck`.
Delivery: auto-chain allowed by user if needed; chain strategy feature-branch-chain (user selected; draft tracker and dependent child PRs). Forecast 550–850 authored lines, generated excluded. Running count: commits `54a33c9` (528) and `3b595fd` (583) authored additions/deletions; each is a cohesive work unit exceeding ~400, requiring size-exception approval for its PR slice rather than code-golf. PR #1 manifest; PR #2 complete tree reader dependent on #1. GitHub PR requires approved issue; local issue 03 exists, remote issue #3 absent.

## Tasks
- [x] I03-1: Implement project manifest with validated source/skill/version/hosts identity and tests. Route: delegated writer (multi-file). Focused test 9/9 and typecheck passed (writer and independent verifier); runtime harness N/A (persistence API); rollback: manifest module and tests. Commit: `54a33c9` (`feat: persist project skill selections`).
- [x] I03-2: Safely retrieve full selected skill trees from built-in/Git sources, preserving bytes and executable bits. Route: delegated writer (multi-file). Git tests 9/9, built-in tests 7/7, typecheck pass (writer and independent verifier); runtime harness N/A (library-only). Rollback: four source/test files. Commit `3b595fd` (`feat: read complete portable skill trees`).
- [x] I03-3: Implement compatible host install, Claude symlink and rollback/conflict behavior. Route: delegated writer (multi-file). Temporary-root harness, focused tests 11/11 and typecheck pass (writer and independent verifier); Windows runtime pending. Rollback: installer module/tests. Commit pending.
- [ ] I03-4: Wire CLI selection, explicit structured-method preview/confirmation, docs, tests. Route: delegated writer (multi-file). Check: focused/full tests and typecheck; commit pending.

## Progress
Exploration completed read-only; dependency issue 02 implemented. I03-1 through I03-3 verified locally. Next: I03-4.
