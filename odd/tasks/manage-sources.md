# Manage Sources

Objective: implement `.scratch/agent-depot/issues/01-manage-sources.md` as the first Agent Depot implementation slice.

Problem: no package, CLI, tests, or source-management code exists yet. Users need a global Git Source catalog and a built-in Source available for explicit discovery selection.

Scope: Git repository URLs (including GitHub), globally registered in one per-user JSON file; add/list/refresh; immutable URL identity; package-owned built-in Source; transient explicit selection from available Sources. No skill discovery, installations, source removal, or automatic selection.

Constraints: TypeScript/Node single package, pnpm preferred/npm compatible, Linux/Windows; terminal-independent application operations with replaceable Git access and state boundaries. No network in tests. Source selection is per discovery call and is not persisted. External commands require explicit confirmation when exposed by CLI. Technical artifact language: English.

TDD: configured mode unknown; `/implement` requests TDD where possible at pre-agreed seams, but no seams were pre-agreed and no runner exists yet. Use behavior-focused tests at the public application operations and CLI after establishing the runner. Exact runner to establish: `pnpm test` (Node built-in test runner), `pnpm typecheck`.

Delivery strategy: user chose stacked-to-main after T2 exceeded the ~400-line review forecast. T1+T2 form the first local slice on `feat/agent-depot-source-management`; T3 will use a follow-on branch from this slice. No push or PR authorized. RDD off.

## Tasks

- [x] T1 Bootstrap one TypeScript/Node package with runnable typecheck, single-file test, and full test suite. Route: delegated writer (multiple non-trivial files; preparation delegated). Checks: `pnpm test:single tests/version.test.ts`, `pnpm typecheck`, and `pnpm test` passed in writer and independent verifier under Node 25; Node 20 runtime not available. Native assessment unassessable due to untracked files, so independent verifier used. Commit: `f32c014`.
- [x] T2 Build global Source operations (add/list/refresh and built-in) with JSON persistence and replaceable Git access. Route: delegated writer (multiple non-trivial files). Checks: `pnpm test:single tests/sources.test.ts` (9/9), `pnpm typecheck`, `pnpm test` (10/10) passed in writer and independent verifier; real Git transport remains for T3. Corrupt state fails closed; parallel add operations serialized. Commit: pending.
- [ ] T3 Expose Source commands and explicit transient source choice for future discovery, cover CLI behavior and documentation, run full suite and two-axis review. Route: delegated writer (multiple non-trivial files). Checks: focused tests, typecheck, full suite, review; commit after checks. Commit: pending.

## Progress

- Exploration: ticket 01 ready-for-agent; repository initially had documentation only. User clarified Git repositories and per-discovery Source choice.
- T1 implementation verified; Node 20 runtime validation remains pending.
- T2 behavior checked independently; no live Git transport yet. Running authored-lines forecast exceeds ~400; user selected stacked-to-main PR slicing.
- Next: commit T2 on current branch, then create follow-on branch for T3. No push or PR requested.
