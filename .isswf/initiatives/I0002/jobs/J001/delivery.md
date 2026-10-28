# Delivery summary

## Work and candidate

- Jobs: I0002/J001 (indicator) and J002 (animated e2e). Briefs: jobs/J001/brief-r1.md, jobs/J002/brief-r1.md.
- Target codebase base: 5efc0f90168c2895e7a17bcec366dbf7ba44adf5.
- Code candidate: d20016c (later commits only touch `.isswf/`).
- Work status: ready for operator acceptance.
- Changed paths: 41 files (758+/123−), all in `src/tui/` and `tests/`, plus `CHANGELOG.md`.
- Authorization: operator conversation 2026-10-28. Scope: iseoane/agent-depot, branch feat/tui-progress, PR to main.

## What changed and why

The operator reported that installing, uninstalling or checking showed a static screen for seconds. Every TUI wait now renders through one `Working` component: a braille spinner, a specific label, and elapsed time from 1s (`12s`, `1m 05s`).

The start time belongs to the operation, so label changes within one operation keep counting. Previously silent waits now show an indicator:
- recipe reloads;
- the Installations finish-reload;
- background App status checks (inline, non-blocking);
- the Profile export-name check.

`AGENT_DEPOT_NO_ANIMATION=1` gives a static `·` with no timer. Tests use this mode.

## Visual summary

| Screen | Before | After |
| --- | --- | --- |
| Installing a Skill | `Installing foo...` (static) | `⠹ Installing foo… 3s` |
| Sources / recipes busy | `Working...` | `⠹ Refreshing Git Source… 2s`, etc. |
| Recipe reload (`r`, Esc) | nothing; "No sources or App recipes" could flash | `⠹ Loading App recipes…` |
| Profile import apply | `Loading Profile…` | `⠹ Applying import… 5s` |
| Updates check | static `Refreshing sources...` → `Checking for updates...` | one spinner with a continuous clock across both phases |
| After an Installations action | silent reload | `⠹ Refreshing installations… 4s` (same clock) |

The "After" column shows the expected rendering. No real-terminal capture was taken.

## Scope

- Included: all TUI wait points in the research map, the test seam, the animated e2e journey, and the palette e2e race fix.
- Excluded: non-TUI CLI commands (still silent during long work), and Windows-specific rendering.

## Checks and results

| Check | Candidate | Result | Limits |
| --- | --- | --- | --- |
| `pnpm typecheck`, `pnpm lint` | d20016c | passed (coordinator) | — |
| `pnpm test` | d20016c | 1079/1079 (coordinator) | animation disabled except in dedicated tests |
| `pnpm test:e2e` (default) | d20016c | 12/12 (coordinator); worker 5×12/12 on db8c1bf | Linux PTY |
| e2e with animation on | d20016c | 12/12 (coordinator); worker 5×12/12 on db8c1bf | Linux PTY; test skips on win32 |
| F1 regression test fails without the fix | f567bb3 with the fix reverted | failed as expected (6 pass, 1 fail), restored to 7/7 | — |
| Real-terminal visual / flicker | — | not run | operator check recommended |

## Problems and resolution

- V001 F1: the Catalog clock restarted after a Package action. Fixed in A002 and covered by a regression test.
- V001 F3: a pre-existing App re-check loop became visible. Fixed by keying the check on the App entry; a test asserts a single run.
- The e2e palette race was fixed by waiting for the cancel result.

## Independent review

- V001 (Opus): changes required (F1). The dispositions are recorded in V001.md.
- V002 (Opus, delta): pass. N1 was resolved by the coordinator's revert check; N2 was fixed mechanically in d20016c.

## Closure and acceptance

- Technical closure: closed on Linux evidence.
- Operator product acceptance: pending.
- Publication state: PR to be opened from feat/tui-progress.
- Human decision: a visual check in a real terminal (spinner smoothness, labels), then the integration decision for the PR.
- Integration boundary: awaiting-human; no merge.

## Integration risk and recovery

Medium. The change touches 26 TUI files, including state machines for every view. The plausible failures are:
- a missed or incorrect busy transition leaving a stale indicator;
- a clock that restarts;
- render cost from an 80ms interval on slow terminals.

Impact is limited to TUI presentation; no data, state or install logic changed. Mitigations:
- typecheck enforces `startedAt` on every busy mode;
- 1079 unit tests and 12 e2e, including an animated PTY journey;
- two independent reviews.

Recovery: revert the merge. No persisted state changes. Residual risk: no visual check in a real terminal, and Windows terminal rendering of braille is unverified.

## Blockers and next action

None technical. Next: push, open the PR, and observe CI on the exact head. Then the operator's visual check and integration decision.
