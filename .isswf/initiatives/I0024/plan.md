# I0024: Make symlink-dependent tests pass on unprivileged Windows

Type: improvement

## J001
- Status: ready
- Objective: Remove the ~43 Windows EPERM symlink failures from the local suite so real failures are visible, and fix the Windows concurrent atomic-rename EPERM in src/atomic-file.ts.
- Depends on: None
- Blocker: None
- Next step: Not today (operator: «perdon paramos tras completar la I0022»). Atomic-rename fix included in scope; start in a later session.

### Acceptance
- Tests that create DIRECTORY links use a junction on win32 (`symlink(target, link, process.platform === "win32" ? "junction" : "dir")`, ideally via one shared test helper), matching product behaviour (src/project-installation.ts:1454 already uses junctions on Windows). Junction targets must be absolute.
- Tests that need FILE symlinks (e.g. tests/app-flow.test.ts:373, tests/cli.test.ts:58) skip on win32 only when symlink creation fails with EPERM (capability probe), with an explicit skip reason; never skip on Linux/CI.
- Assertions are not weakened: tests that assert symlink-specific semantics (e.g. "removes only the symbolic link", readlink results) must still verify the equivalent junction behaviour or skip with reason.
- Local Windows `pnpm test`: EPERM symlink failures 0; report remaining failures by name. Linux/Windows CI stays green.
- Test-only change; no product code change unless a test reveals a real Windows defect (then report, separate commit).

- Product fix (src/atomic-file.ts writeFileAtomically): on win32, retry `rename(temp, file)` a bounded number of times with short backoff when it fails with EPERM/EACCES/EBUSY (destination concurrently being replaced/open), then rethrow; keep the existing locked-fallback semantics and temp cleanup; no behaviour change on POSIX. Regression: the existing `approval receipts use canonical file identity and private atomic storage` (tests/app-flow.test.ts ~375-395, concurrent `Promise.all([approve, approve])`) must pass reliably on Windows; add a focused unit test for the retry (injected/forced EPERM then success, and exhaustion rethrows).

### Evidence
- PR #82 Windows CI run 42085919593 (head 99e1c85) failed only in tests/app-flow.test.ts "approval receipts use canonical file identity and private atomic storage": EPERM rename `<hash>.json.<pid>.<uuid>.tmp -> <hash>.json` at writeFileAtomically (dist/src/atomic-file.js:9) from app-flow approve under Promise.all. Same test passed on b1821f4. Operator: «mas adelante no! dejalo corregido! quier la I0024 cerrada!».
- Local Windows full runs (I0018/I0020/I0021): 23-43 failures with `EPERM: operation not permitted, symlink`.
- Operator: «El EPERM de symlink creo que lo arregle en mi otro repo isswf». Coordinator found isSWF commit 92e6e38 "test: use a directory junction for the evidence alias on Windows" (tests/reviewer-original-evidence.mjs: `symlink(original, alias, 'junction')` on win32). 29 agent-depot test files call `symlink(`.
- Operator accepted: «Ok».
