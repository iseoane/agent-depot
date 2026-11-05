# I0021 J001 worker brief r1

## Trusted start
Operator: «ese orden me parece correcto! encargate coordinador!» (I0020 -> I0021 -> I0022 -> I0019); I0020 merged (7c69a0a). Operator accepted the mock-up in plan.md («ok a todo!!»). Authorizes implementation, tests, local commits; coordinator owns review, push, PR, merge (low-risk merges pre-authorized).

## Factory resources
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/roles/worker.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/skills/isswf-tdd/SKILL.md

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch feat/app-platform-grouping, baseline 7c69a0a (origin/main). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, package-lock.json, AGENTS.md, .isswf/project-setup.md.

## Objective and acceptance
"## J001" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0021/plan.md. Target rendering (Windows machine):
```
▾ Apps (user-global) (2)
    codegraph   windows ✓ approved    linux (other platform)
    engram      windows ✓ approved    linux (other platform)
```
Detail (Enter or existing detail surface) lists each platform recipe with status and file path, marking the one used here. On Linux the same data shows linux first. Recipes with no platform apply everywhere (a single row as today).

Pointers: recipe applicability in src/app-flow.ts (~92-130, `applicable`, `platform`); TUI rows in src/tui/installations-tree.ts, installations-rows.tsx, catalog-tree.ts (Apps group), catalog-panel.tsx, app-actions.tsx. Grouping is presentation (TUI) over AppEntry lists; do not change recipe files, approval or lifecycle semantics (ADR 0007). Actions on a grouped row target the applicable recipe; if several recipes of the same name apply here (conflict), show them separately as today rather than guessing. Non-applicable recipes stay reachable (detail, and any existing remove-recipe path). Marking/batch (J005 per-item progress) must keep working.

Also: Catalog Source node gets a collapsible `Skills (N)` group next to `Packages (N)` (src/tui/catalog-tree.ts buildTree); keep I0020 variants grouping inside it, filtering opening matching groups, marking/`a` and counts correct, ids unique.

## Constraints
- No new dependencies, no schema changes, no real user state/network/Host CLIs.
- Tests under isolated-env with injected fixtures (two-platform recipes, injected platform). TDD: test-only RED commit then GREEN per behavior; never fabricate RED.
- Update existing tests whose expectations change; name them. Check e2e tests (tests/e2e/tui.e2e.test.ts) for text expectations on App rows/Catalog tree and update them too (they are skipped on Windows; reason by reading).
- Run and report: pnpm build, typecheck, lint; affected tui-catalog-*, tui-installations-*, tui-app*, tui-retention tests via `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js`. Classify failures (known Windows EPERM symlink, known flaky "keeps counting the action's elapsed time", other).
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity and report.

## Return
Send the final report through your hand-back message. Acknowledge cwd/scope/role first. Then resources consumed; commits; changed paths; RED/GREEN evidence; exact check results; decisions; risks.
