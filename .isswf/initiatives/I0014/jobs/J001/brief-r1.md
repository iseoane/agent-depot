# Job brief
## Identity and authorization
- Job: I0014/J001, r1. Source: operator 2026-10-29. Mode: bug-to-PR.
- Work ONLY in worktree /home/iseoane/Work/isSWF_worktrees/agent-depot-65 (branch fix/65-test-isolation). Another worker works in /home/iseoane/Work/isSWF_worktrees/agent-depot-59; do not touch it or the main checkout except your report file.
- Side effects: edit tests/ (preload and isolation tests) and, only if needed, test helpers; local commits; push to origin fix/65-test-isolation only and dispatch/read its CI. No PR, no merge. No product code changes.
## Objective
GitHub issue #65 (`gh issue view 65`):
1. git children spawned by tests read the developer's git config via inherited XDG_CONFIG_HOME (and ~/.gitconfig is already sandboxed by HOME). Make git hermetic in the preload: delete XDG_CONFIG_HOME, set GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL into the temp home (or equivalent). Check no test relies on the developer's git identity; fixtures that commit must set their own user.name/email.
2. tests/preload-isolation.test.ts must discriminate on Windows and for HOME: also set HOME, USERPROFILE, APPDATA, LOCALAPPDATA (and the git vars) to sentinel paths in the child env and assert the preload re-pins them.
## Skills and evidence (mandatory)
- isswf-tdd: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-tdd/SKILL.md — RED first for both: (a) a sentinel XDG_CONFIG_HOME git config with a marker (e.g. url.<x>.insteadOf or a config key) observed by a git child before the fix; (b) the extended sentinel test failing with the preload's pinning removed. Paste output.
- Read it before writing code. Deviations section mandatory.
## Acceptance
1. A git child under the preload never sees the sentinel XDG_CONFIG_HOME / system config; full suite still passes (fix fixtures lacking git identity if any).
2. Sentinel test fails on Linux AND Windows if the pinning is removed (show Windows red via CI on a throwaway commit or explain).
3. Linux typecheck, lint, test; Windows CI green on your branch.
## Execution
Sonnet 5.5 / high. Commits test: ..., no attribution lines. Report: /home/iseoane/Work/agent-depot/.isswf/initiatives/I0014/jobs/J001/A001.md (Skills applied and evidence, Deviations, Changes, Results).
