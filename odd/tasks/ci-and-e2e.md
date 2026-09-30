# Feature: CI and TUI end-to-end test

## Objective
Run typecheck, lint, unit tests and a real-PTY TUI e2e test on every pull request, plus a pack smoke test.

## Constraints
- No publish job (publishing is manual for now, user decision).
- Node 24, pnpm, pinned action majors.
- Route: delegated direct (one bounded writer).

## Tasks
- [x] C1 — `.github/workflows/ci.yml`: `check` job, `audit` job (non-blocking, push main + dispatch), concurrency (`pack` job added with P4; e2e step added with C2).
- [ ] C2 — `tests/e2e/tui.e2e.test.ts` + `pnpm test:e2e`: drive the built CLI in a PTY.

## Evidence
- C1: YAML parses (python yaml); actionlint unavailable via npx (no executable).
