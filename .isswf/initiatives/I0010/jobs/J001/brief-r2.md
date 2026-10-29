# Job brief I0010/J001 r2 (correction cycle 1)
Same authorization as r1, plus: you may push to origin fix/54-tui-teardown-races and dispatch/read its CI (`gh workflow run ci.yml --ref fix/54-tui-teardown-races`). No PR, no merge. Read V001.md here.
1. F1: in the 4 settle teardowns, `try { await settle } finally { unmount; await rm }` so a settle timeout never leaks the temp home or leaves views mounted.
2. F2: derive isBusy's glyph class from src/tui/working-model.ts (or reuse its helper) instead of copying the frames.
3. F3: docstring states the residual cases.
4. Run `pnpm typecheck && pnpm lint && pnpm test` on the final head (XDG_CACHE_HOME in a temp dir) and paste counts; push and get a green Windows CI run; record the run ID.
One commit `test: ...`, no attribution lines. Report A002.md.
