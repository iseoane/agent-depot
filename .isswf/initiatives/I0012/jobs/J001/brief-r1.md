# Job brief

## Identity and authorization
- Job: I0012/J001, r1. Source: operator 2026-10-29. Mode: bug-to-PR.
- Work ONLY in worktree /home/iseoane/Work/isSWF_worktrees/agent-depot-58 (branch fix/58-posix-tree-kill). Another worker edits the main checkout: do not touch it except your report file.
- Side effects: edit src/process-runner.ts, tests, CHANGELOG.md; local commits; push to origin fix/58-posix-tree-kill only and dispatch/read its CI. No PR, no merge.

## Objective
GitHub issue #58 (`gh issue view 58 --comments`). On POSIX, `runProcess` timeout/overflow sends SIGTERM to the direct child only (not detached, no group): a wrapper that forks, or descendants inheriting stdout/stderr, keep the pipes open and `close` never fires; a child ignoring SIGTERM also hangs (no SIGKILL escalation). #47 added a bounded settle and tree kill on win32 only. #52 added a child-output tap (stdout may now be piped when a sink is present).

## Skills and evidence (mandatory)
- isswf-debug: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-debug/SKILL.md — reproduce the hang first (POSIX test with a shell wrapper forking a long-sleeping grandchild that holds the pipes; and a SIGTERM-ignoring child).
- isswf-tdd: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-tdd/SKILL.md — the tests above must be RED on main before the fix (paste output with timings).
- Read both before writing code. Deviations section mandatory.

## Acceptance
1. On POSIX, timeout/overflow terminate the whole process group, escalate to SIGKILL after a grace period, and settle within a bound even if a descendant survives (destroy pipes like win32). Result shape stays `(code null, signal "SIGTERM")` for a runner kill (or justify SIGKILL), matching #47 consumers (src/app-flow.ts).
2. Verify and report the impact of `detached: true` on Ctrl-C/terminal signals: a user's Ctrl-C during a long step must still stop the child (test or documented manual check). If detached breaks this, choose another approach and explain.
3. win32 behavior unchanged; Windows CI job green on your branch.
4. No leaked processes after tests (grandchild PIDs asserted gone).
5. Linux typecheck, lint, test, test:e2e pass; CHANGELOG under Unreleased/Fixed.

## Execution
Sonnet 5.5 / high. Commits fix/test, no attribution lines. Report: /home/iseoane/Work/agent-depot/.isswf/initiatives/I0012/jobs/J001/A001.md (sections: Skills applied and evidence, Deviations, Changes, Results).
