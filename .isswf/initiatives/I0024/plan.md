# I0024: Make symlink-dependent tests pass on unprivileged Windows

Type: enhancement

## J001
- Status: completed
- Objective: Remove the ~43 Windows EPERM symlink failures from the local suite so real failures are visible, and fix the Windows concurrent atomic-rename EPERM in src/atomic-file.ts.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Initiative closed; ships with the next release.

### Acceptance
- Tests that create DIRECTORY links use a junction on win32 (`symlink(target, link, process.platform === "win32" ? "junction" : "dir")`, ideally via one shared test helper), matching product behaviour (src/project-installation.ts:1454 already uses junctions on Windows). Junction targets must be absolute.
- Tests that need FILE symlinks (e.g. tests/app-flow.test.ts:373, tests/cli.test.ts:58) skip on win32 only when symlink creation fails with EPERM (capability probe), with an explicit skip reason; never skip on Linux/CI.
- Assertions are not weakened: tests that assert symlink-specific semantics (e.g. "removes only the symbolic link", readlink results) must still verify the equivalent junction behaviour or skip with reason.
- Local Windows `pnpm test`: EPERM symlink failures 0; report remaining failures by name. Linux/Windows CI stays green.
- Test-only change; no product code change unless a test reveals a real Windows defect (then report, separate commit).

- Product fix (src/atomic-file.ts writeFileAtomically): on win32, retry `rename(temp, file)` a bounded number of times with short backoff when it fails with EPERM/EACCES/EBUSY (destination concurrently being replaced/open), then rethrow; keep the existing locked-fallback semantics and temp cleanup; no behaviour change on POSIX. Regression: the existing `approval receipts use canonical file identity and private atomic storage` (tests/app-flow.test.ts ~375-395, concurrent `Promise.all([approve, approve])`) must pass reliably on Windows; add a focused unit test for the retry (injected/forced EPERM then success, and exhaustion rethrows).

### Evidence
- Operator start 2026-11-06: «ataques las iniciativas 24 --> 23 --> 19 ... si el riesgo es bajo integras directamente». Budget: 1 worker, 1 reviewer, 1 correction cycle.
- PR #82 Windows CI run 42085919593 (head 99e1c85) failed only in tests/app-flow.test.ts "approval receipts use canonical file identity and private atomic storage": EPERM rename `<hash>.json.<pid>.<uuid>.tmp -> <hash>.json` at writeFileAtomically (dist/src/atomic-file.js:9) from app-flow approve under Promise.all. Same test passed on b1821f4. Operator: «mas adelante no! dejalo corregido! quier la I0024 cerrada!».
- Local Windows full runs (I0018/I0020/I0021): 23-43 failures with `EPERM: operation not permitted, symlink`.
- Operator: «El EPERM de symlink creo que lo arregle en mi otro repo isswf». Coordinator found isSWF commit 92e6e38 "test: use a directory junction for the evidence alias on Windows" (tests/reviewer-original-evidence.mjs: `symlink(original, alias, 'junction')` on win32). 29 agent-depot test files call `symlink(`.
- Operator accepted: «Ok».
- Worker (sonnet): RED 906a5ac (tests only; worker-observed 3/3 EPERM rename at writeFileAtomically), GREEN 0aceeae (win32 rename retry EPERM/EACCES/EBUSY, 20 attempts, linear 5ms backoff), ca59f68 test-link refactor (tests/link-helpers.ts: directoryLink junction on win32, file-symlink EPERM probe skip; 26 test files). Self-reported reads: worker, comments, code-quality, isswf-tdd. Worker full suite Windows: before 47 failures (44 EPERM symlink), after 5 (4 pre-existing TUI frame timeouts + 1 fixed later; final full run not repeated).
- Coordinator at ca59f68: build/typecheck/lint pass; atomic-file, user-global-skill-inventory, app-flow: 29 pass, 0 fail, 4 skipped. Review R1 dispatched.
- Review R1 (Agent-tool isswf-reviewer, opus, not bound: git-evidence binding invalid, reviewed working tree): Standards PASS, Spec FAIL, risk LOW. B1 blocking: no focused retry unit test (forced EPERM then success; exhaustion rethrows). S1 tui-file-picker silent partial skip; S2 split unsafe-links test; S3 unreachable EPERM catches; S4 noncanonical-installation:146 silent catch (origin unknown). I2: confirm app-flow concurrent approve ran (not skipped) in Windows CI. Final full Windows suite not observed. Correction 1/1 sent to same worker (B1, S1, S4, optional S3, final full suite).
- Correction 1/1: bf0f51f (injectable retry seam + unit tests on every OS; tests passed on existing GREEN, no RED claimed; worker-observed sensitivity: bound+1 makes exhaustion test fail), f5b0f13 (S1 diagnostic, S3/S4 unreachable catches removed). Worker full Windows suite at f5b0f13: 1240 tests, fail 4 (pre-existing TUI frame timeouts: directory read error/export windowing; n adds a Git Source...; Catalog reload after Package action elapsed time; refresh after action elapsed time), EPERM symlink 0. Coordinator at f5b0f13: build/typecheck/lint pass; atomic-file, noncanonical-installation, git-source, user-global-skill-inventory: 51 pass, 0 fail, 1 skipped. Delta small and test-only plus seam: no second review (changed-candidate delta rule, low risk). CHANGELOG ca8cb6d.
- PR #85 at ca8cb6d; CI 42287277303: check/windows/pack SUCCESS, audit SKIPPED; Windows log shows "approval receipts use canonical file identity and private atomic storage" passed (not skipped). Merged with matching head as 0814c57; branch deleted.
