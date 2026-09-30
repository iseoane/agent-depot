# Fallow remediation

Goal: act on the Fallow 3.30.0 findings without changing behavior, CLI output, error messages or the public CLI contract.
Baseline: health score 77.2, 170 functions over threshold, 51 critical; tests 199/199.
TDD: strict (source: user instruction). Runner: `pnpm test` / `pnpm test:single tests/<f>.test.ts`. Checks per commit: `pnpm typecheck && pnpm lint && pnpm test`.
Delivery: branch refactor/reduce-complexity; work-unit commits; no push, no merge.

- [x] Task D: Reduce complexity of `cli.ts runUninstall` (49/65), `cli.ts runInstall` (31/44), `project-installation.ts installProjectSkillTransaction` (31/44), plus `skill-discovery.ts consumeNestedMapping`, `parseSkillFrontmatter`, `source-state.ts parseState`. Pure refactor: existing tests are the characterization net; extracted logic units get focused tests when new.
- [ ] Task E: Fallow config/integration.
- [ ] Task F: Path-traversal finding triage.

## Task D progress / evidence
- Route: inline (mechanical pure refactors, one file per commit; existing 199 tests are the characterization net, no new logic units).
- Commits: runUninstall split (cli.ts); runInstall split into manifest/single project installs (cli.ts); installProjectSkillTransaction helpers (project-installation.ts); parseState split (source-state.ts); frontmatter and nested-mapping readers (skill-discovery.ts). Each passed typecheck, lint and 199/199 tests.
- Fallow (cyc/cog before -> after): runUninstall 49/65 -> 12/11; runInstall 31/44 -> 6/5; installProjectSkillTransaction 31/44 -> 16/20; parseState 28/38 -> 10/8; parseSkillFrontmatter 27/37 -> below threshold; consumeNestedMapping 25/42 -> 13/16.
- Note: over-threshold count rises because Fallow flags small uncovered functions by estimated CRAP; supplying coverage data (Task E) is the lever for that.
- Remaining critical in cli.ts/project-installation.ts (parseInstallOptions, runUpdate, runCli, adoptExistingProjectSkill, ...) not in scope of this pass.
