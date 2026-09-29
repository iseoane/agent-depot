# Configure ESLint

Objective: Add minimal ESLint flat config with typescript-eslint and a lint script for this TypeScript project.

Scope: package.json, pnpm-lock.yaml, eslint.config.js, this task record. Do not execute lint. Preserve unrelated changes in the original worktree. User explicitly authorized commit and push.

TDD: not configured for this change; check runner `pnpm typecheck` and `pnpm test`. ESLint must not be executed per user instruction.

Delivery: ask-on-risk; forecast under 400 authored lines excluding lockfile. Route: delegated worker, because configuration, package metadata, and lockfile are multiple non-trivial surfaces.

- [x] T1 Configure ESLint and dependencies; verify with typecheck and tests, without executing lint. Acceptance: lint script and flat config cover TS source/tests; record exact check outcomes. Commit: `d5f99c3`.
  - ESLint 9 and typescript-eslint installed; Node minimum raised to 20.19 to align with resolved dependencies.
  - `pnpm typecheck`: passed (writer and independent verifier).
  - `pnpm test`: passed (133 tests, writer and independent verifier before final engine change).
  - ESLint was not executed, per user instruction; its runtime behavior remains unverified.
- [x] T2 Commit isolated work unit and push feature branch. Acceptance: clean feature worktree and remote branch confirmed. Commit: `d5f99c3`; pushed `feat/configure-eslint` to `origin`.

Next: ESLint runtime remains intentionally unverified until the user permits executing lint.
