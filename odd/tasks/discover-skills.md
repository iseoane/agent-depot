# Discover Skills

Objective: implement `.scratch/agent-depot/issues/02-discover-skills.md` on `feat/discover-skills`.

Scope: explicit per-invocation source selection, recursive read-only portable skill discovery, lifecycle subtree exclusions, candidate presentation without installation or selection. Ticket 01 source operations are implemented despite stale ticket status.

Decisions: scan cached Git mirror HEAD without implicit refresh; built-in source has an explicit package-owned root (empty until skills are shipped); lifecycle path segments `in-progress`, `beta`, `deprecated`, `retired`; avoid symlink traversal. TDD mode unknown (no pre-agreed seams); use behavior-focused tests. Runner: `pnpm test:single <file>`, `pnpm typecheck`, `pnpm test`. RDD off. Delivery: local feature branch, no push or PR.

## Tasks

- [ ] T1 Implement read-only source snapshot discovery and application operation with focused tests. Route: delegated writer (multiple non-trivial files). Checks: focused tests and typecheck. Commit: pending.
- [ ] T2 Expose explicit CLI discovery and document usage with tests. Route: delegated writer (multiple non-trivial files). Checks: focused tests, typecheck, full suite, two-axis review. Commit: pending.

## Progress

- Explored ticket/spec and implementation seams through read-only mapper. Branch created from main. Forecast: about 350–500 authored lines; review-slice strategy ask-on-risk if it exceeds ~400.
