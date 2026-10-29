# Job brief

> Recorded retroactively by the coordinator on 2026-10-28 from the dispatch handoff actually sent to the worker; at dispatch time the brief lived only in the handoff text.

## Identity and authorization

- Job ID and brief revision: I0001/J001, r1.
- Source issue or request: GitHub issue #41 "Win32 package install fail" (iseoane/agent-depot).
- Trusted authorization reference: operator conversation 2026-10-28, Claude Code session 0d334bb8 ("adelante con la A").
- Request mode: feature-to-PR start (bug fix).
- Repository and permitted side effects: iseoane/agent-depot; feature branch `fix/41-win32-cmd-spawn`, commit, push, PR against `main`, CI observation. No merge.
- Operation ownership: coordinator owns Git/PR/CI; worker edits the checkout only (no commit/push).
- Profile path and applicable skills: isSWF 1.5.0 `.agents/roles/worker.md`; host guide `.agents/hosts/claude-code.md`.
- Coordinator-assigned ID: I0001/J001.

## Objective

- Observable outcome: on Windows, installing a Package whose host CLI is an npm global (e.g. `pi`) runs it instead of failing with `spawn ... ENOENT`.
- Why: the resolver picked npm's extensionless sh shim before `pi.cmd`, and Node refuses to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980). Operator chose option A: run batch files through `cmd.exe /d /s /c` with cross-spawn-style escaping.

## Scope and acceptance

- Included: `src/executable-resolution.ts`, `src/process-runner.ts`, new `tests/windows-spawn.test.ts`, `CHANGELOG.md`.
- Exclusions: process-tree kill, `.cmd` vanish race, real-Windows CI.
- Acceptance criteria: see the plan's J001 acceptance.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`; CI on the PR head.

## Independent review

- Required: yes.
- Criteria: Standards + Spec; escaping correctness and injection safety; resolver edge cases; unchanged non-Windows behavior; callers of `runProcess`.
- Constraints: `isswf-reviewer`, Opus 5.5, medium effort, read-only, exact uncommitted diff snapshot.

## Inputs and bases

- Document-input checkpoint: none committed (handoff text).
- Target codebase base: 5efc0f90168c2895e7a17bcec366dbf7ba44adf5.
- Grounding: coordinator diagnosis of `src/executable-resolution.ts:59-61` (bare name first on win32) and the issue's error text; a partial candidate written by the coordinator was handed to the worker to finish.

## Dependencies and ownership

- Dependencies: none.
- Checkout: primary checkout `/home/iseoane/Work/agent-depot` (sequential writer; no worktree because the Claude Code Agent tool cannot bind a child to a prepared worktree, see iseoane/isSWF#89).

## Execution and checkpoints

- Requested model and effort: worker Sonnet 5.5 / high; reviewer Opus 5.5 / medium (per `.isswf/project-setup.md`).
- Correction budget: at most 2 rounds.
- Delivery destination: origin, base `main`, branch `fix/41-win32-cmd-spawn`.
- Integration decision: awaiting-human for PR #42.
