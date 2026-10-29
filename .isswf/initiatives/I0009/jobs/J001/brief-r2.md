# Job brief I0009/J001 r2 (correction cycle 1 of 2)
Same authorization as r1 (worktree, push to fix/47-win32-kill-tree, dispatch CI). Read V001.md here.
1. F1: when the runner terminated the child (timeout/overflow), settle with `code: null` and a signal ("SIGTERM", matching the old win32 shape) on win32, including the grace path. First verify on Windows CI what base `child.kill()` reported (add a temporary or permanent assertion); report the observed value. Add `signal`/`code` assertions to the win32 timeout and overflow tests. POSIX unchanged.
2. F2: skip taskkill when `child.exitCode !== null || child.signalCode !== null`; keep the grace timer.
3. F3: reword CHANGELOG and JSDoc to "every command on Windows".
4. F4: assert Number.isInteger(pid) first in test 3.
5. Linux typecheck/lint/test; Windows run with new tests green. Commits fix(win32)/test, no attribution. Report A002.md.
