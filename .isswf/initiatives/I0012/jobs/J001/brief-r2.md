# Job brief I0012/J001 r2 (correction cycle 1)
Same authorization as r1. Read V001.md here. isswf-tdd applies: tests first, show red.
1. F1: listProcessTree never rejects: try/catch around spawn/stdio setup resolving [rootPid], and a .catch at the call site falling back to the direct child. Add a test for the ps fallback (e.g. PATH without ps, or injected spawn failure) proving it still kills the child and settles; show it red before the fix if feasible.
2. F2: apply the `pid !== child.pid || isRunning(child)` guard to the SIGTERM step too.
3. F3: doc comment wording.
4. Linux typecheck/lint/test/test:e2e; push and green CI (incl. windows); record run ID. Commits test/fix, no attribution. Report A002.md.
