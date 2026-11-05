# I0018 J005 worker brief r1

## Trusted start
Operator: «si coordinador, vamos a hacer las tareas de I0018 y asi la cerramos!» after J005 was scoped (plan.md J005). Authorizes implementation, focused tests, local commits on the feature branch, independent review and PR by the coordinator. No merge/release.

## Factory resources
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/roles/worker.md
- Selected methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/skills/isswf-tdd/SKILL.md (TDD for the two behaviors), C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/skills/isswf-performance/SKILL.md (re-measurement only).

## Checkout
- Working directory: C:/0-BackupVF/WorkSpace/agent-depot (sole sequential writer, no worktree).
- Branch perf/tui-retention-progress, baseline 54db6f7df283cfd75446d21adbd92c7aeb371fa7 (origin/main, includes 0.6.9).
- Preserve and NEVER stage: .isswf/**, .pi/**, .scratch/** (except your own new probe outputs, also unstaged), package-lock.json, and the modified AGENTS.md / .isswf/project-setup.md.

## Objective
Two UX/perf improvements in the TUI, scoped in plan.md J005:

### A. Retain view data across tab revisits
Views unmount on tab change (src/tui/app.tsx ~93-130) so Catalog (src/tui/catalog-state.ts) and Installations (src/tui/installations-view.tsx reload()) reload from scratch on each revisit (~2-3 s measured, J004).
- On revisit, render the last valid data immediately with an explicit refreshing/stale indicator, then replace with fresh data when the reload completes.
- Retained model lives above the views (app-level session holder or module keyed by project root + Source config), display-only.
- Invalidate (drop or mark stale and force reload) after Source refresh/add/remove, recipe/approval changes and every install/update/uninstall/host/adoption/package/app action.
- Mutation previews/confirmations must keep using fresh state as today; never treat cached Host/approval/ownership data as truth for a mutation.
- Keyboard input stays enabled while refreshing; actions on stale rows must re-validate through existing preview flows (they already do; do not weaken).

### B. Progress for multi-item operations in Installations
src/tui/app-actions.tsx prepareNext/execute process marked Apps sequentially with generic labels "Preparing App step…"/"Running App step…". Also inspect package-actions.tsx and manage-actions.ts for multi-item paths.
- Busy labels include item name and position, e.g. "Running App step: <name> (2/5)…" and "Preparing App step: <name> (2/5)…".
- Show completed results so far (e.g. count or last result) while the batch continues.
- The post-action reload shows as its own labelled phase (already "Refreshing installations…"; keep it distinct and, with A, show retained data instead of a blank wait where safe).
- Failure of one item keeps progress and continues remaining items as today.

## Constraints
- ADR 0006: flows stay in core modules; this work is TUI view/state only. Check docs/adr/ and CONTEXT.md vocabulary. Register any new src/ module in .fallowrc.json boundaries.
- No new dependencies. No persisted schema changes. No real user state, Host CLIs, network, installs.
- Tests: load tests/isolated-env.ts (scripts already preload it), inject operations/state paths; use existing TUI test helpers (look at tests for installations/catalog views and package-panel). TDD: test-only RED commit then GREEN commit per behavior where cheap; do not fabricate RED.
- Checks to run and report exactly: pnpm build, pnpm typecheck, pnpm lint, focused pnpm test:single for touched tests, affected TUI tests. Full pnpm test optional; known local Windows EPERM symlink failures exist — report, do not fix unrelated.
- Re-measure (optional, after GREEN): build is NOT installed globally; .scratch/measure-tui-paint.mjs targets the global CLI. If you measure, adapt a copy pointing at node dist/src/cli.js tui and report N=3; navigation keys only.
- Commits: conventional commits, NO Co-Authored-By or AI attribution lines. Local commits only; no push/PR.

## Budget
One worker call, no nested agents, no automatic retry. Stop and report on material ambiguity, permission denial or missing resource.

## Return
Acknowledge working directory, scope, role first. Then: resources actually consumed; changed paths; commits (SHA + message); RED/GREEN evidence; exact check results; measurements if any; risks and open questions.
