# Built-in doctor skills

## Objective
Ship `doctor-md-agents` (from `~/0-workspace/agents-md-doctor`) and `doctor-md-skill` (from `~/0-workspace/doctor-md-skill`) as the first built-in skills under `skills/`, cleaned up as standalone original work.

## Constraints
- Do not copy `.git`, `.atl`, `odd/`, `BACKLOG.md`, `__pycache__`.
- TDD: enabled (session config); runners `python3 -m unittest` inside each skill's `scripts/`, `pnpm test` for the repo.

## Tasks
- [x] T1 — Import both skills into `skills/`, clean up docs and scripts. Route: delegated (2+ non-trivial files).
- [x] T2 — Rewrite both `collect_sessions.py` from scratch against their existing tests. Route: delegated.

- [x] T3 — `defaultBuiltInSkillsRoot()` resolves the package-root `skills/` (walks up to nearest package.json, so it works from `src/` and `dist/src/`). Commit 44b1db7. Route: inline (2 files).
- [x] T4 — `SKILL_TREE_LIMITS.maxFileBytes` 1 MiB -> 2 MiB (all Sources; total 8 MiB and other limits unchanged and sufficient). Commit 2b4d9aa. Route: inline.

## Checks
- `grep for stale references in skills/` returns nothing (after T2).
- Python test suites pass in both skills; `pnpm test` passes; built-in discovery lists both skills.

## Delivery
Strategy: ask-on-risk. Forecast exceeds 400 lines (imported content), mostly moved files.

## Progress

### T1 (done)
- Imported git-tracked files (minus .gitignore, BACKLOG.md, odd/, .atl/) into `skills/doctor-md-agents` and `skills/doctor-md-skill`; `assets/pierre-diffs.js` untouched.
- Cleaned up docs, scripts and tests; replaced a harness-specific test class in doctor-md-agents and replaced it with a generic unknown-`--harness` test; dropped dangling BACKLOG.md references; renamed leftover `skill-doctor` identifiers.
- `python3 -m unittest discover -p 'test_*.py'`: doctor-md-agents 95 tests OK; doctor-md-skill 42 tests OK.
- `grep for stale references in skills/`: no hits.
- `pnpm test`: 241 pass, 0 fail.
- Discovery with explicit builtInRoot=`skills/` lists both SKILL.md files.
- Open issues found (not fixed here): (1) `defaultBuiltInSkillsRoot()` resolves to `dist/skills` when run from `dist/src`, not the package `skills/`; (2) `readSkillTree` for doctor-md-skill fails with "exceeds the safe size limit" on `assets/pierre-diffs.js` (1.16 MB). Both need follow-up tasks before the skills are installable.

### T3 (done, 44b1db7)
- RED: new test failed (root resolved to `dist/skills`). GREEN after `findPackageRoot`. package.json has no `files` field, so `skills/` ships. The e2e lifecycle test asserted an empty built-in discover list; updated to expect the two doctor skills (implementation detail: built-in was empty).

### T4 (done, 2b4d9aa)
- RED: `readSkillTree` of doctor-md-skill failed on `pierre-diffs.js` (1,156,623 B). GREEN after raising limit. No docs mention the limit.

### T2 (done)
- Route: delegated writer (2 large files). Both `collect_sessions.py` rewritten from scratch (Reader-per-harness + neutral Event stream + single `digest_session`; sampling as pure functions). Public names imported by tests/`detect_machine_sessions.py` kept; no tests altered.
- Verification: unittest agents 95 OK, skill 42 OK; `pnpm test` 243 pass; lint/typecheck clean; provenance grep empty; built-in `readSkillTree` works for both (17 files/315,577 B; 15 files/1,324,176 B).
- Commit: see git log (`refactor(skills): rewrite session collectors as original code`).
