# Job brief

## Identity and authorization
- Job: I0011/J001, r1. Source: operator 2026-10-29. Mode: feature-to-PR.
- Work ONLY in worktree /home/iseoane/Work/isSWF_worktrees/agent-depot-52 (branch feat/52-child-output from main). Another worker is editing the main checkout /home/iseoane/Work/agent-depot (branch fix/54-…): do not touch it except your report file.
- Side effects: edit src/ (process-runner, progress, cli option parsing, callers), tests/, CHANGELOG.md, README/help text for the flag; local commits; you may push to origin feat/52-child-output only and run `gh workflow run ci.yml --ref feat/52-child-output` / `gh run view` for Windows evidence. No PR, no merge.

## Objective
GitHub issue #52 and its comments (`gh issue view 52 --comments`), with the operator decisions there:
- TTY default: a tail of the last few lines (e.g. 3, width-truncated) of child output (npm, pi, git, recipe commands) under the #44 progress line, cleared with it. Failure output printed as today.
- Non-TTY / AGENT_DEPOT_NO_ANIMATION=1: no tail; as today.
- `mayPrompt` steps stay static, no tail redraw.
- Global `--verbose`: stream full child output live to stderr, line by line, no spinner (plain step lines).
- stdout byte-identical; capture for error reporting and output caps preserved (timedOut/outputTooLarge/SIGTERM shape from #47 unchanged).
- TUI only if trivial; otherwise CLI only and say so.

## Skills and evidence (mandatory)
- isswf-tdd: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-tdd/SKILL.md — red first for the runner/progress behavior (paste failing output before implementation).
- isswf-e2e: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-e2e/SKILL.md — one PTY journey showing the tail and its clearing; one non-TTY check.
- Read both (and their references) BEFORE writing code. Comments: why, not what.
- Deviations section mandatory if any skill step is skipped.

## Acceptance
1. Unit tests: tail rendering/truncation/clearing, mayPrompt suppression, non-TTY unchanged, --verbose streaming, stdout unchanged, caps/timeout results unchanged.
2. PTY e2e for the tail; passes repeatedly.
3. Linux typecheck, lint, test, test:e2e pass; Windows CI job green on your branch (dispatch it).
4. CHANGELOG under Unreleased; --verbose documented in CLI help.

## Execution
Sonnet 5.5 / high. Conventional commits, no attribution lines of any kind. Report: /home/iseoane/Work/agent-depot/.isswf/initiatives/I0011/jobs/J001/A001.md (sections: Skills applied and evidence, Deviations, Changes, Results).
