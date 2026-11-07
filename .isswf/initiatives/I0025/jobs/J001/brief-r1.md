# I0025 J001 worker brief r1

## Trusted start
Operator 2026-11-06: «corrígelo» (the flaky TUI teardown). Authorizes test changes and local commits; coordinator owns review, push, PR, merge (low risk pre-authorized).

## Factory resources (isSWF 1.8.0)
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/worker.md
- Required: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/comments.md, C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/code-quality.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/skills/isswf-debug/SKILL.md (cause already reproduced by the coordinator; confirm) and C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/skills/isswf-tdd/SKILL.md for the helper regression.

## Checkout
C:/0-BackupVF/WorkSpace/agent-depot, branch fix/tui-test-teardown-order, baseline 8a30989 (main). Sole writer. Never edit/stage .isswf/**, .pi/**, .scratch/**, AGENTS.md; explicit staging; no git stash.

## Objective and acceptance
"## J001" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0025/plan.md.

## Constraints
- Tests only (tests/**). No product change. Do not use rm maxRetries or sleeps to mask the race.
- Never run python or long heredocs; nothing may be left running in the background when you finish.
- Run: pnpm build, typecheck, lint; each touched suite via `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js`; one full `pnpm test` (known on this machine: 4 TUI frame timeouts). Conventional commits, no AI attribution, local commits only.

## Budget
One worker call, no nested agents, no automatic retry.

## Return
Acknowledgement, resources consumed, commits (full SHAs), changed paths, regression RED/GREEN evidence (or honest no-RED), checks, decisions, risks.
