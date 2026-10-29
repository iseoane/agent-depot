# Job brief

## Identity and authorization
- Job: I0004/J001, r1. Source: operator, 2026-10-29 ("ataquemos #50 ... como coordinador").
- Mode: bug-to-PR. Side effects: edit `src/package-host-state.ts` and tests; local commit on `fix/50-pi-lock-bin`; no push.

## Objective
GitHub issue #50 (read it: `gh issue view 50`). `isMatchingRootOnlyNpmLock` in `src/package-host-state.ts` (~:430-460) rejects npm's dependency-free root lock when the root entry carries `bin`, so fresh Pi installs report `local changes` / `verified=unknown`.

## Scope and acceptance
1. Accept root `bin` only when it equals npm's normalization of the manifest `bin`: object form exact match; string form normalized to `{ [unscoped package name]: path }` (verify npm's rule; if unsure, accept object form only and report). Paths compared after npm normalization (e.g. leading `./` stripped) only if you can justify it.
2. Fail closed (new tests): mismatched bin, extra bin entry, bin in lock but not manifest, unknown root metadata, dependencies, tracked lock edits, other untracked files, tracked modifications.
3. A test shows verified HEAD evidence persists for the #50 lockfile (exact JSON from the issue).
4. Preserve ADR 0009 (`docs/adr/0009-*`): no deleting/rewriting host files, no broad ignore of package-lock.json.
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass. Load `tests/isolated-env.ts` for state-writing tests (see AGENTS.md).
6. Add a CHANGELOG entry under Unreleased if the file has that convention.

## Execution
- Sonnet 5.5 / high. One commit `fix(package): ...` with no attribution lines of any kind.
- Report: changed files, test counts, the npm string-bin decision with evidence, and anything not done. Write the report to `.isswf/initiatives/I0004/jobs/J001/A001.md`.
