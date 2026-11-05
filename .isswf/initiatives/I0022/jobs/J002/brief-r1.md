# I0022 J002 worker brief r1

## Trusted start
Operator agreed to do the J001 review follow-ups now as J002 («si»), then stop for today. Authorizes implementation, tests, local commits; coordinator owns review, push, PR, merge (low-risk merges pre-authorized).

## Factory resources
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/roles/worker.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/skills/isswf-tdd/SKILL.md

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch fix/profile-import-followups, baseline c8ee4e9 (origin/main, includes PR #82). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, package-lock.json, AGENTS.md, .isswf/project-setup.md.

## Objective and acceptance
"## J002" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0022/plan.md. Code: src/profile-import.ts (summary/reason, ~88-89 version reason, ~146-147 and ~236-242 Skill name disambiguation), src/tui/profile-view.tsx (~308, ~322, ~540-551 Enter on headers), CLI import output (find where previewImport/results lines are printed for `agent-depot import`). Keep selection, recheck and write paths unchanged; classification stays in core (ADR 0006).

Note: the narrow-terminal fix from J001 (one-row clipped group headers, tests/tui-profile.test.tsx "import list in a narrow terminal…", e2e tests/e2e/tui.e2e.test.ts:1091) must keep passing.

## Constraints
- No new dependencies, no schema change, no real user state/network/Host CLIs.
- Tests under isolated-env with injected fixtures; TDD test-only RED commit then GREEN; never fabricate RED. Update affected CLI tests and name them.
- Run and report: pnpm build, typecheck, lint; tui-profile, profile-import, profile, cli via `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js`. Classify failures (known Windows EPERM symlink; known flaky timing; other).
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity and report.

## Return
Final report through your hand-back message: acknowledgement, resources consumed, commits, changed paths, RED/GREEN evidence, exact check results, decisions, risks.
