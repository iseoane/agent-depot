# Source cache lock diagnostic

Goal: Make refresh timeout report exact lock directory and safe diagnostic guidance without treating lock as stale.
Source: user-authorized after Matt Pocock source refresh was blocked by an empty lock directory.
TDD: not explicitly enabled; ordinary tests via pnpm test, pnpm typecheck, pnpm lint.
Delivery: ask-on-risk; branch fix/portable-skill-support-files; forecast under 100 authored lines.

- [x] Task 1 (delegated writer): Improve lock-timeout message with path and caution about concurrent refresh; add focused regression test. Evidence: independent verification `pnpm test` 155/155, `pnpm typecheck`, `pnpm lint`, `git diff --check` passed. Initial full suite timed out due a fake-timer test race; corrected and rerun successfully. Commit: pending.
