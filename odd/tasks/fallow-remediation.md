# Fallow remediation

Goal: act on the Fallow 3.30.0 findings without changing behavior, CLI output, error messages or the public CLI contract.
Baseline: health score 77.2, 170 functions over threshold, 51 critical; tests 199/199.
TDD: strict (source: user instruction). Runner: `pnpm test` / `pnpm test:single tests/<f>.test.ts`. Checks per commit: `pnpm typecheck && pnpm lint && pnpm test`.
Delivery: branch refactor/reduce-complexity; work-unit commits; no push, no merge.

- [x] Task D: Reduce complexity of `cli.ts runUninstall` (49/65), `cli.ts runInstall` (31/44), `project-installation.ts installProjectSkillTransaction` (31/44), plus `skill-discovery.ts consumeNestedMapping`, `parseSkillFrontmatter`, `source-state.ts parseState`. Pure refactor: existing tests are the characterization net; extracted logic units get focused tests when new.
- [x] Task E: Fallow config/integration (branch chore/fallow-integration; commits e911b12, cbd2abd).
- [ ] Task F: Path-traversal finding triage.

## Task D progress / evidence
- Route: inline (mechanical pure refactors, one file per commit; existing 199 tests are the characterization net, no new logic units).
- Commits: runUninstall split (cli.ts); runInstall split into manifest/single project installs (cli.ts); installProjectSkillTransaction helpers (project-installation.ts); parseState split (source-state.ts); frontmatter and nested-mapping readers (skill-discovery.ts). Each passed typecheck, lint and 199/199 tests.
- Fallow (cyc/cog before -> after): runUninstall 49/65 -> 12/11; runInstall 31/44 -> 6/5; installProjectSkillTransaction 31/44 -> 16/20; parseState 28/38 -> 10/8; parseSkillFrontmatter 27/37 -> below threshold; consumeNestedMapping 25/42 -> 13/16.
- Note: over-threshold count rises because Fallow flags small uncovered functions by estimated CRAP; supplying coverage data (Task E) is the lever for that.
- Remaining critical in cli.ts/project-installation.ts (parseInstallOptions, runUpdate, runCli, adoptExistingProjectSkill, ...) not in scope of this pass.

## Task E progress / evidence
- Route: inline (config, scripts and docs; no logic units). Branch chore/fallow-integration, not pushed.
- `.fallowrc.json`: entries `src/cli.ts` + `tests/**/*.test.ts`; ignores dist, .scratch, .codegraph, .atl, .fallow, coverage. `eslint.config.js` is allowed unmatched by boundary coverage.
- Boundaries (zones, `requireAllFiles: true`): cli (cli.ts) -> application (project-installation, skill-update, update-batch, user-global-skill-inventory, skill-adoption, user-method) -> core (sources, source-state, skill-discovery, project-manifest) -> infrastructure (git-source, process-runner, version). Imports may only go downward; infrastructure imports nothing. All rules pass today; verified a temporary infra->application import is reported. Cycles inside `core` (sources <-> skill-discovery) are pre-existing, reported by dead-code as circular dependencies only when a violation exists (18 listed in that run), not gated here.
- Health thresholds: Fallow defaults kept (cyc 20, cog 15, CRAP 30) so real problems stay visible; the gate is `--min-score 85` (baseline 88 with coverage) since `health` alone exits 1 on any finding. Dupes threshold 6% (baseline 5.5%).
- Coverage: Fallow reads raw V8 coverage (`NODE_V8_COVERAGE`) and maps through source maps, so `pnpm test:coverage` rebuilds dist with `tsconfig.coverage.json` (sourceMap) and runs node --test; no lcov needed, no new dependencies. Result: over-threshold functions 183 -> 29 (1230/1230 matched); health score 78 B -> 88 A.
- Scripts: `audit:dead-code`, `audit:dupes`, `audit:health`, `audit:all` (`audit` collides with the pnpm builtin). Cache dirs `coverage/` and `.fallow/` gitignored.
- Checks: typecheck, lint, 199/199 tests; audit:dead-code, audit:dupes, audit:health all exit 0.
- Remaining 29 flagged functions (parseInstallOptions 42/24 CRAP 47, runUpdate, scanRoot, adoptExistingProjectSkill, ...) are candidates for a follow-up refactor pass.
