# Job brief

## Identity and authorization
- Job: I0006/J001, r1. Source: operator, 2026-10-29. Mode: feature-to-PR.
- Side effects: edit `tests/` and the `test:single` script in `package.json`; one local commit on `fix/48-test-gaps`; no push. No product code changes; if a gap reveals a product bug, stop and report.

## Objective
GitHub issue #48 (`gh issue view 48`).
1. Package-flow manual fallback: in `src/package-flow.ts` (~:546) launch errors `ENOENT`, `EACCES`, `ENOEXEC`, `EPERM`, `EINVAL` become `manual required`. Only a WSL case is tested (`tests/package-flow.test.ts:648`). Model on the App-flow counterpart in `tests/app-lifecycle.test.ts`.
2. `pnpm test:single` maps only `\.ts$` → `.js`; make `.tsx` map too (`tests/foo.test.tsx` → `dist/tests/foo.test.js`). Check how tsx tests compile into dist first.

## Acceptance
1. A test asserts each of the five codes yields `manual required` in Package flow, and a non-listed code does not (keep existing behavior for it).
2. `pnpm test:single tests/tui-working.test.tsx` runs that file (report output count); `pnpm test:single tests/version.test.ts` still works; default with no arg unchanged.
3. Load `tests/isolated-env.ts` for any state-writing test (AGENTS.md).
4. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass. No CHANGELOG entry unless the file lists dev tooling changes.

## Execution
- Sonnet 5.5 / high. One commit `test: ...`, no attribution lines of any kind.
- Report to `.isswf/initiatives/I0006/jobs/J001/A001.md`.
