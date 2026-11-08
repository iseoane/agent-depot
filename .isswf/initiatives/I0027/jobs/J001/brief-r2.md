# Job brief J001 / r2

Supersedes r1 for execution; r1 objective, scope, exclusions and acceptance stand unchanged (see brief-r1.md).

## Authorization
- Operator 2026-11-08: «haz la I0027, solo esa, ya sabes si el riesgo sale bajo, la integras directamente». Feature-to-PR: implement, check, review, commit, push feat/93-updates-by-source, PR, exact-head CI; low-risk merge per .isswf/project-setup.md.
- Budget: 1 worker (sonnet/medium), up to 3 review rounds / 2 correction cycles.
- Checkout: /home/iseoane/Work/agent-depot, branch feat/93-updates-by-source, base 74cd929 (code = r1 base 5db1aee). Sequential writer.

## Coordinator decisions (on planner proposal, observer: isswf-planner opus/low, read-only, 2026-11-08)
- (a) Rows that cannot be assessed stay in the existing flat fold below the tree; only "update available" rows are grouped.
- (b) Groups start expanded.
- (c) New core module src/update-groups.ts (generic, no tui imports), registered in the application zone of .fallowrc.json; tree mapping in src/tui/updates-tree.ts.
- (d) Inside the tree a Package leaf shows the descriptor name plus `  <path>` only when its root is not the Source root; flat strings outside the tree use formatPackageSelection (moved verbatim from package-cli.ts into package-model.ts; CLI output byte-identical). Verify displayRoot("") never yields "."; if it does, add a root-aware variant without changing CLI output.

## Reading map (planner, at 74cd929; reopen before editing)
- src/tui/updates.ts:32-74 row types; :223 Skill rows; :266-270 Package rows (`Package: ${describeCoordinates}` → '.'); :348 prepareUpdates; :469 result label.
- src/package-model.ts:177-182 describeCoordinates; src/package-cli.ts:120, 370-390 formatPackageSelection/sourceToken/describeSelectionCoordinate/displayRoot.
- src/tui/updates-model.ts:40-51 viewOf/Entry; src/tui/updates-view.tsx:102-161; src/tui/updates-panel.tsx:45-75 EntryLine; src/tui/updates-keys.ts:41 move, :53-62 select, :65-76 fold (:70 hard-coded summary cursor); src/tui/updates-flow.ts:73 checked→listed.
- src/tui/tree.ts TreeNode/flattenVisible/toggleNode/expandNode/collapseOrParent (tests/tui-tree.test.ts); installations-tree.ts:63 example.
- package-rows.ts:83, :129; package-actions.tsx:65-218 labels.
- Likely affected tests: tui-updates-view, tui-updates-apps, tui-updates-colors, tui-package-journey, tui-installations-bulk, tui-profile, tests/e2e Updates; package-boundaries.test.ts must stay green.

## Units / commits (isswf-tdd: RED test-only commit, then GREEN)
1. update-groups core: deterministic order (Sources by label then id; Packages then Skills; empty subgroups omitted; Apps last; leaf order preserved).
2. Package labels: no '.' / 'name@.' anywhere; Source shown.
3. Tree model + group toggle (tri-state [x]/[-]/[ ]; Space on group adds/removes only its updatable leaf keys).
4. TUI wiring: right/left expand/collapse, group Space, `a` unchanged, Enter preview; selected set == prepareUpdates input; scope filter hides empty groups; headers count in windowing; ids without path separators.
5. Adjust existing tests/e2e.

## Skills and evidence required
- isswf-tdd: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.6.1/.agents/skills/isswf-tdd/SKILL.md — per unit: RED commit (full SHA, command, failing assertion), GREEN commit. Deviations declared with reason.
- Comments per project standards (why, not what).
- Report resources consumed/missing.

## Checks
pnpm build, typecheck, lint, test, test:e2e, audit:all. Report exact counts; pre-existing failures named with baseline evidence.

## Exclusions
No update semantics/preview/confirmation changes; no CLI output change; no Catalog/Installations grouping; no push/PR (coordinator owns delivery); do not touch .isswf/.
