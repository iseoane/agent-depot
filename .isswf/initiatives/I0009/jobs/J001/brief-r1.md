# Job brief

## Identity and authorization
- Job: I0009/J001, r1. Source: operator 2026-10-29 ("atacar en paralelo la 47"). Mode: bug-to-PR.
- Work ONLY in worktree /home/iseoane/Work/isSWF_worktrees/agent-depot-47 (branch fix/47-win32-kill-tree, based on ci/46-windows which adds the Windows CI job). Another worker is concurrently editing ci/46-windows in the main checkout: do not touch that checkout or branch.
- Side effects: edit src/process-runner.ts and tests; local commits; you may push to origin fix/47-win32-kill-tree only and run `gh workflow run ci.yml --ref fix/47-win32-kill-tree` / `gh run view` to verify on Windows. No PR, no merge.
- Records: write your report to /home/iseoane/Work/agent-depot/.isswf/initiatives/I0009/jobs/J001/A001.md (main checkout path, that file only).

## Objective
GitHub issue #47 (`gh issue view 47`). On win32, `.cmd`/`.bat` hosts run via `cmd.exe /d /s /c`; on timeout or output overflow `child.kill()` (src/process-runner.ts ~:107/114/128) kills only cmd.exe, leaving the real program running and holding stdio open.

## Acceptance
1. On win32, timeout and overflow terminate the whole tree (e.g. `taskkill /pid <pid> /T /F`, awaited or fire-and-forget with bounded wait; handle taskkill failure/absence gracefully). POSIX behavior unchanged (consider whether POSIX has the analogous issue with detached groups; report, don't change).
2. The result resolves within a bounded time after the kill even if a grandchild ignored it (don't hang on `close`).
3. win32-only test: a `.cmd` launches a long-sleeping node grandchild; with a short timeout, runProcess settles within a bound and the grandchild PID is gone afterwards. Same for overflow if feasible. Skipped with reason elsewhere.
4. Linux: typecheck, lint, test pass. Windows: your new tests pass on the windows job of your branch's CI (other pre-existing win32 failures are I0008's, ignore them but report).
5. CHANGELOG entry under Unreleased/Fixed.

## Execution
Sonnet 5.5 / high. Commits `fix(win32): ...` / `test: ...`, no attribution lines of any kind.
