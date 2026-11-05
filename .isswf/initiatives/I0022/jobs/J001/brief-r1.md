# I0022 J001 worker brief r1

## Trusted start
Operator: «ese orden me parece correcto! encargate coordinador!» (I0020 -> I0021 -> I0022 -> I0019); I0022 scope accepted («3. OK»). I0020 and I0021 merged (main 9980c20). Authorizes implementation, tests, local commits; coordinator owns review, push, PR, merge (low-risk merges pre-authorized).

## Factory resources
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/roles/worker.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/skills/isswf-tdd/SKILL.md

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch feat/profile-import-readable, baseline 9980c20 (origin/main). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, package-lock.json, AGENTS.md, .isswf/project-setup.md.

## Surface (verified by coordinator — this is the screen in the operator's screenshot)
TUI Profile tab → Import Profile list: src/tui/profile-view.tsx (rows rendered ~520-560 with "(not selectable)" suffix), classification in core src/profile-import.ts (labels ~97-121, preview lines ~182). The screenshot shows a flat list of 38 rows like:
- `[ ] 1 same: Source https://github.com/mattpocock/skills (included: true) (not selectable)`
- `[ ] 3 conflict: Skill agent-depot-apprecipe; hosts: existing ["claude","pi"] → incoming ["claude","codex","opencode","pi"] (not selectable)`
- `[x] 6 add: Skill skills/engineering/ask-matt` ... (28 Skill rows)
- `[ ] 35 same: App recipe codegraph (linux; unapproved; Apps are not installed) (not selectable)`
- `[x] 38 add: Package pi . from https://github.com/michael-denyer/pstack-claude.git (latest; saved selection)`

## Objective and acceptance
"## J001" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0022/plan.md. In short:
1. Group the list into collapsible sections: **To import** (status add; sub-grouped by Source/repo, containing its Skills, Packages; App recipes in their own sub-group), **Unchanged** (same; collapsed by default), **Conflicts** (not selectable). Show counts per group. Reuse the existing tree navigation pattern (useTreeNavigation/expand like Catalog/Installations) rather than inventing one.
2. Plain-language labels saying the effect: e.g. `Add Source <repo>`, `Add Skill <name>` (show Skill name; path only if needed to disambiguate), `Add App recipe <name> (<platform>) — not approved, not installed`, `Select Package <name> from <repo> (latest)`, `Already identical`.
3. Conflicts: one short human reason instead of raw JSON, e.g. `hosts: would add codex, opencode` (compute added/removed host sets), recipe conflict naming the existing recipe file basename.
4. Selection, `a` (all), space toggle, Enter preview and confirm semantics unchanged: only `add` items selectable; preview/confirm still produced by core (ADR 0006). Plain labels may live in core (they are also used by CLI `profile import` preview — check CLI output tests and keep CLI readable/consistent; state what changed for CLI).
5. Fix misleading recipe label: recipes ARE imported (written as files), never approved or installed.

## Constraints
- No new dependencies, no schema/profile format change, no real user state/network/Host CLIs.
- Tests under isolated-env with injected profile fixtures; TDD test-only RED commit then GREEN; never fabricate RED. Update affected tests (tui-profile*, profile*, cli profile, e2e by reading) and name them.
- Run and report: pnpm build, typecheck, lint; tui-profile*, profile*, cli tests via `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js`. Classify failures (known Windows EPERM symlink; known flaky timing tests; known tui-profile "a directory read error stays recoverable…" timeout under load; other).
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity and report.

## Return
Final report through your hand-back message: acknowledgement, resources consumed, commits, changed paths, RED/GREEN evidence, exact check results, decisions (grouping, labels, CLI impact), risks.
