# I0024 J001 worker brief r1

## Trusted start
Operator 2026-11-06: «quiero que ataques las iniciativas 24 --> 23 --> 19, por favor encargate, y ya sabes si el riesgo es bajo integras directamente». Authorizes implementation, tests, local commits; coordinator owns review, push, PR and merge (low-risk merges pre-authorized by the setup delivery policy).

## Factory resources (isSWF 1.8.0)
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/worker.md
- Required for code changes: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/comments.md, C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/code-quality.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/skills/isswf-tdd/SKILL.md (atomic-file retry only)

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch fix/windows-symlink-tests, baseline 63bae12 (origin/main). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, AGENTS.md.

## Objective and acceptance
"## J001" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0024/plan.md (Objective, Acceptance, Evidence).

## Reading map (baseline 63bae12)
- src/atomic-file.ts:10-20 writeFileAtomically, rename at line 20.
- src/project-installation.ts ~1454: product already uses junctions on win32.
- tests/app-flow.test.ts ~373-395: file symlink and concurrent approve test.
- tests/cli.test.ts ~58: file symlink.
- 30 test files contain `symlink(` (`grep -rln "symlink(" tests`). Prefer one shared test helper (e.g. in tests/) for directory links and the EPERM capability probe.
- Reference fix: isSWF commit 92e6e38 used `symlink(original, alias, 'junction')` on win32.

## Constraints
- No new dependencies, no real user state/network/Host CLIs. Tests under isolated-env.
- Test-link changes are refactor-only test infrastructure (no honest RED: declare it). Atomic-file retry: TDD, test-only RED commit then GREEN; never fabricate RED.
- Run and report: pnpm build, typecheck, lint, and full `pnpm test` on this Windows machine (before/after failure counts, remaining failures by name and class). Do not run e2e unless cheap.
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only; no push.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity and report.

## Return
Acknowledgement, resources consumed, commits, changed paths, RED/GREEN evidence, exact check results, decisions, risks.
