# Feature: CI and TUI end-to-end test

## Objective
Run typecheck, lint, unit tests and a real-PTY TUI e2e test on every pull request, plus a pack smoke test.

## Constraints
- No publish job (publishing is manual for now, user decision).
- Node 24, pnpm, pinned action majors.
- Route: delegated direct (one bounded writer).

## Tasks
- [x] C1 — `.github/workflows/ci.yml`: `check` job, `audit` job (non-blocking, push main + dispatch), concurrency (`pack` job added with P4; e2e step added with C2).
- [x] C2 — `tests/e2e/tui.e2e.test.ts` + `pnpm test:e2e`: drive the built CLI in a PTY.

## Evidence
- C1: YAML parses (python yaml); actionlint unavailable via npx (no executable).
- C2 tool: `@homebridge/node-pty-prebuilt-multiarch` 0.14.1 (devDependency). It ships prebuilt binaries for linux x64/arm64 and node ABIs 111-147 inside the package, so no compiler or install script is needed (`allowBuilds: false` in pnpm-workspace.yaml; pnpm 11 otherwise refuses the install script). `node-pty` was not chosen: it compiles with node-gyp. `script -qfec` fallback not needed, so the test is not Linux-only.
- C2: `pnpm test:e2e` x3 -> 2 pass / 0 fail (~1s). Unit glob narrowed to `dist/tests/*.test.js` so e2e stays out of `pnpm test`.
