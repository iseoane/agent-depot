# Job brief I0008/J001 r2 — iterate until Windows is green

Operator decision 2026-10-29: iterate until the Windows job passes fully in this PR (overrides the 2-cycle budget for this job).

## Facts from run 40847494535 (log: ci-run-40847494535-failed.log in this folder)
- windows: 1128 tests, 1061 pass, 60 fail, 7 skipped. The `.cmd` round-trip test PASSES.
- Failure classes seen: path separators in assertions (e.g. /\.claude\/skills\/one/), symlink semantics, 9 TUI "Timed out waiting for frame", 3 "Recipe changed, invalid or not applicable", WSL resolver, real-git tests, isolation-preload test.
- audit job fails on main's code too: fallow "Boundary coverage: src/progress.ts:1 no matching boundary zone" (regression from #44). Fix in `.fallowrc.json` boundaries.

## Authorization (extends r1)
- You may push to `origin ci/46-windows` only, run `gh workflow run ci.yml --ref ci/46-windows`, and read runs with `gh run view/watch`. No PR, no other branches, no merge.
- Product code changes ARE allowed when a failure is a real Windows product bug; each one gets its own commit `fix(win32): ...` and a line in the report explaining the user-visible impact. Test-only fixes use `test: ...`.
- Never weaken an assertion to make it pass; prefer platform-correct expectations (path.join/sep). Skips only with an explicit reason and only for genuinely POSIX-only behavior; list every skip.

## Loop
Classify all 60 (table: test → class → test-fix | product-fix | skip). Fix, verify locally on Linux (typecheck, lint, test, audit:all if runnable), push, dispatch CI, read failures, repeat until windows, check, pack and audit are all green. If something needs a design decision or a real Windows machine, stop and report.

## Report
A002.md: classification table, product bugs found, skips, run IDs per iteration, final green run ID. No attribution lines in commits.
