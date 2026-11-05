# I0020 J001 worker brief r1

## Trusted start
Operator: «ese orden me parece correcto! encargate coordinador!» (order I0020 -> I0021 -> I0022 -> I0019) after accepting I0020 scope («ok a todo!!»). Authorizes implementation, tests, local commits; coordinator owns review, push, PR, merge (operator grant: low-risk PRs may be merged after review and green exact-head CI).

## Factory resources
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/roles/worker.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.7.0/.agents/skills/isswf-tdd/SKILL.md

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch fix/catalog-duplicates, baseline 8de09e1 (origin/main). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, package-lock.json, AGENTS.md, .isswf/project-setup.md.

## Objective and acceptance
See "## J001" in C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0020/plan.md (acceptance and evidence, including the real impeccable probe). Summary:
1. Non-installable Package descriptors not shown in Catalog (keep warning reachable in Source diagnostics if such a surface exists; otherwise just do not list them). They must not reserve Skills.
2. Unique Catalog node ids even with identical descriptor coordinates; regression: expand/collapse repeatedly, row count stable.
3. Skill discovery: ignore mirror directories of non-managed hosts (managed Hosts: Claude, Codex, Pi, OpenCode — check src for the canonical Host list and their skill directories, e.g. `.claude/skills`, `.agents/skills`, `.pi/...`, `.opencode/...`, `.codex/...`) and test fixture trees (`tests/**`, `test/**`, `fixtures/**` — justify the final list); collapse identical Skills (same name + same content digest) into one candidate with a deterministic canonical path preference. Same name with different content: keep both, distinguishable.
Do it in core discovery (src/skill-discovery.ts and/or package discovery), not in TUI views (ADR 0006). Read docs/adr/0006, 0009 and CONTEXT.md first. Consider effects on: install by path (existing manifests/records referencing a now-hidden path must still resolve/update/remove — do NOT break installed records; if a recorded path is hidden, keep it discoverable for that record or explain), CLI `discover`/list output, Package-owned Skill matching, profiles.

## Constraints
- No new dependencies, no persisted schema migration, no real user state/network/Host CLIs.
- Tests under isolated-env with fixture Git Sources; TDD RED (test-only commit) then GREEN per behavior where cheap; never fabricate RED.
- Run and report: pnpm build, typecheck, lint, focused tests (use `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js` on Windows), and all affected discovery/catalog/package/profile tests. Name every failure and classify (known Windows EPERM symlink, baseline failure verified at 8de09e1, flaky).
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity (especially the installed-records compatibility question) and report.

## Return
Acknowledge cwd/scope/role first. Then resources consumed; commits; changed paths; RED/GREEN evidence; exact check results; behavior decisions (excluded directory list, canonical preference); compatibility analysis for existing records; risks.
