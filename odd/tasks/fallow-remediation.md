# Fallow remediation

Goal: act on the Fallow 3.30.0 findings without changing behavior, CLI output, error messages or the public CLI contract.
Baseline: health score 77.2, 170 functions over threshold, 51 critical; tests 199/199.
TDD: strict (source: user instruction). Runner: `pnpm test` / `pnpm test:single tests/<f>.test.ts`. Checks per commit: `pnpm typecheck && pnpm lint && pnpm test`.
Delivery: branch refactor/reduce-complexity; work-unit commits; no push, no merge.

- [ ] Task D: Reduce complexity of `cli.ts runUninstall` (49/65), `cli.ts runInstall` (31/44), `project-installation.ts installProjectSkillTransaction` (31/44), plus `skill-discovery.ts consumeNestedMapping`, `parseSkillFrontmatter`, `source-state.ts parseState`. Pure refactor: existing tests are the characterization net; extracted logic units get focused tests when new.
- [ ] Task E: Fallow config/integration.
- [ ] Task F: Path-traversal finding triage.

## Task D progress / evidence
