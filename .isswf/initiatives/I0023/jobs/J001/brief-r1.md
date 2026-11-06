# I0023 J001 worker brief r1

## Trusted start
Operator 2026-11-06: «quiero que ataques las iniciativas 24 --> 23 --> 19, por favor encargate, y ya sabes si el riesgo es bajo integras directamente». Authorizes implementation, tests, local commits; coordinator owns review, push, PR, merge (low-risk merges pre-authorized).

## Factory resources (isSWF 1.8.0)
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/worker.md
- Required for code changes: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/comments.md, C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/code-quality.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/skills/isswf-tdd/SKILL.md (S1 bug: regression RED first)

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch fix/app-recipe-removal-other-platform, baseline 0814c57 (origin/main after PR #85). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, AGENTS.md.

## Objective and acceptance
"## J001" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0023/plan.md.

I4 decision is already made: the operator-accepted I0021 mock-up shows `codegraph   windows ✓ approved    linux (other platform)` (I0021 plan line 14, 23). Use "✓" in the approved status badge accordingly.

## Reading map
- src/app-recipe-removal.ts:39-58 planAppRecipeRemoval; line 46 tracking matched by name only; line 55 `installed = ... || tracked !== undefined`; :70-80 removeAppRecipe rechecks via plan.
- src/app-flow.ts:71-75 TrackedApp {name, recipeFile, installedVersion}: recipeFile allows canonical matching.
- src/tui/sources-recipes.tsx:50 recipeMemberLine (I2: make module-private), :138 and :374 users; the picker mode around :374.
- tests/e2e/tui.e2e.test.ts:341 stale comment (I4).
- ADR 0007 in docs/adr/ ("a recipe for another platform … stays removable"). CONTEXT.md vocabulary.
- Existing tests: tests/app-recipe-removal.test.ts, Sources recipe TUI tests (grep for recipeMemberLine / "Recipes named").

## Constraints
- No new dependencies, no real user state/network/Host CLIs; isolated-env with injected state paths.
- Classification and safety stay in core (ADR 0006); views only present.
- S1 via TDD: test-only RED commit with the tracked-record regression, then GREEN. Other items may be refactor/presentation with focused tests; declare no-RED where honest.
- Run and report: pnpm build, typecheck, lint; focused suites via `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js` (pnpm test:single is broken under Git Bash on Windows). Full `pnpm test` once at the end with counts and remaining failure names (known: 4 TUI frame timeouts).
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only; explicit staging.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity and report.

## Return
Acknowledgement, resources consumed, commits, changed paths, RED/GREEN evidence, exact check results, decisions, risks.
