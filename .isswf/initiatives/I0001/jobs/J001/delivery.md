# Delivery summary

## Work and candidate

- Job: I0001/J001, brief `jobs/J001/brief-r1.md` r1.
- Target codebase base: 5efc0f90168c2895e7a17bcec366dbf7ba44adf5.
- Candidate: d1c1bef6ba9ccec549d0c65741f715a670d3958e.
- Work status: ready for operator acceptance.
- Changed paths: src/executable-resolution.ts, src/process-runner.ts, src/package-flow.ts, src/app-flow.ts, tests/windows-spawn.test.ts, tests/app-lifecycle.test.ts, CHANGELOG.md.
- Authorization: operator conversation 2026-10-28 ("adelante con la A"). Scope: iseoane/agent-depot, branch fix/41-win32-cmd-spawn, PR to main.

## What changed and why

Installing a Package whose host CLI is an npm global (e.g. `pi`) failed on Windows with `spawn ... ENOENT`. Two things were wrong. The win32 resolver picked npm's extensionless sh shim before `pi.cmd`. And Node cannot spawn `.cmd` files without a shell.

The resolver now only accepts PATHEXT candidates. Batch files run through `cmd.exe /d /s /c` with MSVCRT-quoted, caret-escaped arguments. Unsafe arguments are rejected as a manual step.

## Visual summary

| Situation on Windows | Before | After |
| --- | --- | --- |
| `pi`, `pi.cmd`, `pi.ps1` on PATH | resolves `pi` (sh shim) → ENOENT | resolves `pi.cmd` → runs via cmd.exe |
| only the extensionless `pi` | ENOENT | "manual required" (no executable) |
| argument with `&`, `|`, `<`, `>` or a line break to a `.cmd` | n/a | EINVAL → "manual required" |
| `.exe` host (e.g. `claude`) / Linux / macOS | direct spawn | unchanged |

## Scope

- Included: resolver, runner, EINVAL handling in package/app flows, tests, CHANGELOG.
- Excluded: process-tree kill on timeout, `.cmd` vanish race, Windows CI.

## Checks and results

| Check | Candidate | Result | Limits |
| --- | --- | --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` 1073/1073 | tree before the final mechanical cleanup | passed (coordinator) | Linux only |
| typecheck, lint, `tests/windows-spawn.test.ts` 11/11 | d1c1bef | passed (coordinator) | Linux only |
| CI `check`, `pack` | d1c1bef | first run: `check` failed in an unrelated test (`tui-sources-recipes` teardown ENOTEMPTY); rerun of the failed job passed | ubuntu-latest |
| Real Windows execution | — | not run | needs the operator or a Windows runner |

## Problems and resolution

- V001 S1, a backslash-run encoding bug inherited from cross-spawn: reproduced and fixed in A002.
- CI flake: a pre-existing race between test teardown and a background recipe `reload()` after Esc. It is unrelated to this change. Tracked for I0002, which turns that reload into a visible loading state.

## Independent review

- V001 (approve, findings dispositioned) and V002 (approve). Both on uncommitted snapshots over base 5efc0f9; d1c1bef adds only the two mechanical follow-ups noted in V002.

## Closure and acceptance

- Technical closure: closed on Linux evidence; real-Windows behavior unverified.
- Operator product acceptance: pending.
- Publication state: PR https://github.com/iseoane/agent-depot/pull/42, OPEN, head d1c1bef, base main.
- Human decision: verify on Windows (install `isswf-pi-resources` from the TUI) and decide whether to merge PR #42.
- Integration boundary: awaiting-human; no merge or auto-merge.

## Integration risk and recovery

Medium. The fix depends on how real cmd.exe parses the line, and that has not been run. The impact is limited to Windows `.cmd` hosts, and a failure surfaces as "failed" or "manual required". Reverting the commit restores the previous (broken) behavior, and no persisted state is affected. The full assessment is in the PR description.

## Blockers and next action

Awaiting the operator's Windows check and integration decision for PR #42.
