# Job brief
## Identity and authorization
- Job: I0013/J001, r1. Source: operator 2026-10-29. Mode: bug-to-PR.
- Work ONLY in worktree /home/iseoane/Work/isSWF_worktrees/agent-depot-59 (branch fix/59-tui-panel-paging). Another worker works in /home/iseoane/Work/isSWF_worktrees/agent-depot-65; do not touch it or the main checkout except your report file.
- Side effects: edit src/tui/ and tests/; local commits; push to origin fix/59-tui-panel-paging only and dispatch/read its CI. No PR, no merge.
## Objective
GitHub issue #59 and comments (`gh issue view 59 --comments`). Package approval and confirm panels (and the profile export name stage, and the file picker at narrow heights) are not paged; when content exceeds terminal height Ink squeezes them and text overlaps. Page them like the Updates tab does. Remove the test accommodations: tests/tui-package-journey.test.tsx `rows: 60`, tests/tui-profile.test.tsx height derived from temp-path length, tests/tui-file-picker.test.tsx stubbed /picker.
## Skills and evidence (mandatory)
- isswf-tdd: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-tdd/SKILL.md — first remove the accommodations / add tests at default heights with long paths and show them RED (overlap or height assertion) before the fix; paste output.
- isswf-e2e: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-e2e/SKILL.md — one PTY journey of the Package approval panel at a small terminal height with a long path, asserting no overlap and that paging reveals all content.
- Read both before writing code. Comments: why, not what. Deviations section mandatory.
## Acceptance
1. No panel listed renders more rows than the terminal; all content reachable by paging (keys consistent with the Updates tab; footer shows them).
2. Consent content (what will be approved/installed) is never hidden without an indication that more exists.
3. Accommodations removed; tests pass at default heights with long paths (e.g. 45-char TMPDIR).
4. Linux typecheck, lint, test, test:e2e; Windows CI green on your branch; CHANGELOG under Unreleased/Fixed.
## Execution
Sonnet 5.5 / high. Commits fix(tui)/test, no attribution lines. Run tests with XDG_CACHE_HOME in a temp dir; clean temp dirs your runs leave. Report: /home/iseoane/Work/agent-depot/.isswf/initiatives/I0013/jobs/J001/A001.md (Skills applied and evidence, Deviations, Changes, Results).
