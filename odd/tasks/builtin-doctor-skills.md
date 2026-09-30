# Built-in doctor skills

## Objective
Ship `doctor-md-agents` (from `~/0-workspace/agents-md-doctor`) and `doctor-md-skill` (from `~/0-workspace/doctor-md-skill`) as the first built-in skills under `skills/`, cleaned up as standalone original work.

## Constraints
- Do not copy `.git`, `.atl`, `odd/`, `BACKLOG.md`, `__pycache__`.
- TDD: enabled (session config); runners `python3 -m unittest` inside each skill's `scripts/`, `pnpm test` for the repo.

## Tasks
- [ ] T1 — Import both skills into `skills/`, clean up docs and scripts. Route: delegated (2+ non-trivial files).
- [ ] T2 — Rewrite both `collect_sessions.py` from scratch against their existing tests. Route: delegated.

## Checks
- `grep for stale references in skills/` returns nothing (after T2).
- Python test suites pass in both skills; `pnpm test` passes; built-in discovery lists both skills.

## Delivery
Strategy: ask-on-risk. Forecast exceeds 400 lines (imported content), mostly moved files.

## Progress
