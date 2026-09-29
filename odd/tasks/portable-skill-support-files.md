# Portable skill support files

Goal: Allow skill-relative `agents/` supporting files and disclose incompatibility before confirmation, consistently across installation and update.

Source: user-approved implementation after Matt Pocock global adoption trial.
TDD: not enabled by explicit request; ordinary functional tests (`pnpm test`, `pnpm typecheck`, `pnpm lint`).
Delivery: ask-on-risk; forecast under 400 authored lines; branch `fix/portable-skill-support-files`.

- [x] Task 1 (delegated multi-file writer): Accept skill-relative `agents/` in portable trees, preserve existing path safety; validate install and update consistently. Added focused regression tests. Evidence: project-installation 22 passed, update-batch 14 passed, skill-update 10 passed, typecheck passed, git diff --check passed. No commit (explicit authorization pending).
- [x] Task 2 (delegated multi-file writer): Surface incompatibility before install and update confirmation and test preview behavior; document semantics. Evidence: independent verifier: 154 tests passed, typecheck passed, lint passed, git diff --check passed. No commit (explicit authorization pending).

No work-unit commit without separate explicit user request per repository safety policy.
