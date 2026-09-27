# Manage Sources

Objective: implement `.scratch/agent-depot/issues/01-manage-sources.md` as the first Agent Depot implementation slice.

Problem: no package, CLI, tests, or source-management code exists yet. Users need a global Git Source catalog and a built-in Source available for explicit discovery selection.

Scope: Git repository URLs (including GitHub), globally registered in one per-user JSON file; add/list/refresh; immutable URL identity; package-owned built-in Source; transient explicit selection from available Sources. No skill discovery, installations, source removal, or automatic selection.

Constraints: TypeScript/Node single package, pnpm preferred/npm compatible, Linux/Windows; terminal-independent application operations with replaceable Git access and state boundaries. No network in tests. Source selection is per discovery call and is not persisted. External commands require explicit confirmation when exposed by CLI. Technical artifact language: English.

TDD: configured mode unknown; `/implement` requests TDD where possible at pre-agreed seams, but no seams were pre-agreed and no runner exists yet. Use behavior-focused tests at the public application operations and CLI after establishing the runner. Exact runner to establish: `pnpm test` (Node built-in test runner), `pnpm typecheck`.

Delivery strategy: ask-on-risk. Forecast: approximately 350–500 authored changed lines; check budget before next commit if it exceeds ~400 lines. Current branch: `feat/agent-depot-source-management`; no push or PR authorized. RDD off.

## Tasks

- [x] T1 Bootstrap one TypeScript/Node package with runnable typecheck, single-file test, and full test suite. Route: delegated writer (multiple non-trivial files; preparation delegated). Checks: `pnpm test:single tests/version.test.ts`, `pnpm typecheck`, and `pnpm test` passed in writer and independent verifier under Node 25; Node 20 runtime not available. Native assessment unassessable due to untracked files, so independent verifier used. Commit: pending.
- [ ] T2 Build global Source operations (add/list/refresh and built-in) with JSON persistence and replaceable Git access. Route: delegated writer (multiple non-trivial files). Checks: behavior-focused operation tests, typecheck, isolated state, no default external Sources, stable URL identity. Commit: pending.
- [ ] T3 Expose Source commands and explicit transient source choice for future discovery, cover CLI behavior and documentation, run full suite and two-axis review. Route: delegated writer (multiple non-trivial files). Checks: focused tests, typecheck, full suite, review; commit after checks. Commit: pending.

## Progress

- Exploration: ticket 01 ready-for-agent; repository initially had documentation only. User clarified Git repositories and per-discovery Source choice.
- T1 implementation verified; Node 20 runtime validation remains pending.
- Next: commit T1 and implement T2. Preserve the branch and existing documentation.
