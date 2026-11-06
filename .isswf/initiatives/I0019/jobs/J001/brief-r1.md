# I0019 J001 worker brief r1

## Trusted start
Operator 2026-11-06: «quiero que ataques las iniciativas 24 --> 23 --> 19, por favor encargate, y ya sabes si el riesgo es bajo integras directamente». Authorizes implementation, tests, docs, local commits; coordinator owns review, push, PR, merge (low-risk merges pre-authorized).

## Factory resources (isSWF 1.8.0)
- Factory root: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0
- Role: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/worker.md
- Required for code changes: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/comments.md, C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/code-quality.md
- Methodology: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/skills/isswf-tdd/SKILL.md (behavioural items: RED first)
- Reference: C:/Users/iseoane/.claude/plugins/cache/isswf/isswf/1.8.0/.agents/roles/references/design-principles.md (new option and shared preview contract)

## Checkout
- C:/0-BackupVF/WorkSpace/agent-depot, branch feat/explicit-project-root, baseline 15065c7 (origin/main after PR #86). Sole sequential writer.
- Never edit/stage: .isswf/**, .pi/**, .scratch/**, AGENTS.md.

## Objective and acceptance
"## J001" of C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0019/plan.md.

## Scope clarification (coordinator research)
Project scope exists only for install (selected Skills and `--manifest`) and update (check/apply). Removal is user-global only by ADR 0003 (docs/adr/0003-project-uninstall-out-of-scope.md) and src/skill-hosts.ts / src/skill-removal.ts have no project scope. So "every project-scope preview" means install, manifest install, update check and update apply, in CLI and TUI. Do not add project removal or hosts changes. If you find another project-scope write path, include it and report it.

## Reading map (lines observed at 0814c57; reconfirm at baseline)
- src/cli.ts:1443 `path.resolve(dependencies.projectRoot ?? process.cwd())`; :1461-1560 project install context; :1504 outputInstallPreview; :1190 describeUpdatePreview(plan, scope, projectRoot); :1321 `--scope` option parsing (add `--project <path>` alongside, for the commands that take --scope project).
- src/skill-install.ts:261 preview `target:` line; src/update-flow.ts:140 update preview `target:`.
- src/project-manifest.ts defaultProjectManifestPath; src/path-safety.ts for validating the selected root.
- TUI: src/tui/environment.ts:15-24 projectRoot dependency (defaults to cwd); project-scope previews in src/tui/catalog-installs.ts, src/tui/installations.ts, src/tui/updates.ts.
- ADR 0006 (core owns plans/previews); CONTEXT.md vocabulary; README project-scope section (README.md ~100-115).

## Design constraints
- The `Project: <absolute path>` line and the warnings are produced by shared core code used by both CLI and TUI; views only render them.
- Warnings are non-blocking: (a) root inside a Git repository but not its top level (name the top level; detect without spawning network, e.g. walking up for `.git` or a local git call through the existing process runner—justify the choice); (b) no project manifest and no Host project directory (`.claude/`, `.pi/`, `.codex/`, `.opencode/`, ... use the Host definitions in the code, not a hard-coded guess).
- `--project`: resolved, must exist and be a directory, rejected cleanly otherwise; default stays cwd. Usage/help text updated.
- No writes on cancel; tests inject state paths and run under isolated-env.

## Constraints
- No new dependencies, no real user state/network/Host CLIs.
- TDD: test-only RED commit(s) then GREEN. Never fabricate RED. Docs commit separate is fine.
- Run and report: pnpm build, typecheck, lint; focused suites via `node --import ./dist/tests/isolated-env.js --test dist/tests/<file>.js` (pnpm test:single is broken under Git Bash); one full `pnpm test` (known: 4 TUI frame timeouts on this machine). If you touch TUI text checked by tests/e2e, update those assertions (local Windows e2e cannot start a pty; Linux CI runs it).
- Conventional commits, NO Co-Authored-By/AI attribution. Local commits only; explicit staging.

## Budget
One worker call, no nested agents, no automatic retry. Stop on material ambiguity (for example a product decision about wording or TUI placement not settled by the acceptance) and report.

## Return
Acknowledgement, resources consumed, commits, changed paths, RED/GREEN evidence, exact check results, decisions, risks.
