# Discover Skills

Objective: implement `.scratch/agent-depot/issues/02-discover-skills.md` on `feat/discover-skills`.

Scope: explicit per-invocation source selection, recursive read-only portable skill discovery, lifecycle subtree exclusions, candidate presentation without installation or selection. Ticket 01 source operations are implemented despite stale ticket status.

Decisions: scan cached Git mirror HEAD without implicit refresh; built-in source has an explicit package-owned root (empty until skills are shipped); lifecycle path segments `in-progress`, `beta`, `deprecated`, `retired`; avoid symlink traversal. TDD mode unknown (no pre-agreed seams); use behavior-focused tests. Runner: `pnpm test:single <file>`, `pnpm typecheck`, `pnpm test`. RDD off. Delivery: local feature branch, no push or PR.

## Tasks

- [x] T1 Implement read-only source snapshot discovery and application operation with focused tests. Route: delegated writer (multiple non-trivial files). Checks: focused discovery 3/3, sources 10/10, Git 7/7 and typecheck passed in writer and independent verifier. Commit: `9c452d2`.
- [x] T2 Expose explicit CLI discovery and document usage with tests. Route: delegated writer (multiple non-trivial files). Checks: focused CLI tests 7/7, typecheck, and full suite 28/28 passed. Independent verifier confirmed focused CLI tests 7/7, typecheck and full suite 28/28. Two-axis review attempted: review agents could read sources but not Git hunks, so a full diff review is not claimed; the Spec axis identified over-reading of source files, corrected in follow-up. Commit: `34a9938`; follow-up fix pending.

## Progress

- Explored ticket/spec and implementation seams through read-only mapper. Branch created from main. Forecast: about 350–500 authored lines; review-slice strategy stacked-to-main selected by user after T1 crossed ~400 authored lines. T2 is on `feat/discover-skills-cli`, based on T1.
- T1 snapshot discovery committed; native assessment was unassessable due to untracked files, so an independent verifier ran and passed.
- T2 CLI discovery is implemented with explicit Source IDs, cached snapshot operation wiring, candidate-only output, actionable missing-source/cache guidance, README usage, and behavior tests. Verification passed. Two-axis review agents lacked Git diff access; source-based Spec review found excessive reads of non-skill files. Follow-up filtering fix passed focused tests and the 29-test full suite in writer and independent verifier; commit pending.
