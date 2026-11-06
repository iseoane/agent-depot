# I0019: Make the project-scope target explicit and safe

Type: enhancement

## J001
- Status: completed
- Objective: Make every project-scope Skill operation show, sanity-check and optionally select the project root, instead of silently using the current working directory.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Initiative closed; ships with the next release.

### Acceptance
- Every `--scope project` preview (CLI and TUI: install, remove, update, hosts) starts with a prominent `Project: <absolute path>` line, produced by the shared core flows (ADR 0006), not by views.
- Non-blocking warning in the preview when the project root is inside a Git repository but not its top level (naming the Git top level), or has no project manifest and no Host project directory (`.claude/`, `.pi/`, ...). A brand-new project must still be installable; no hard block.
- CLI `--project <path>` selects the project root explicitly; path is resolved, must exist and be a directory, and goes through `path-safety.ts`. Default remains the current working directory (backward compatible).
- TUI shows the active project root (header or project-scope preview).
- Focused regressions: cwd default, subdirectory-of-repo warning, empty new project allowed with warning, existing manifest no warning, `--project` valid/invalid paths, no writes on cancel; state paths injected and isolated-env loaded.
- Docs (README project-scope section) updated.

### Evidence
- Operator start 2026-11-06: «ataques las iniciativas 24 --> 23 --> 19 ... si el riesgo es bajo integras directamente». Budget: 1 worker, 1 reviewer, 1 correction cycle. Coordinator scope finding: project scope exists only for install (incl. --manifest) and update; removal is user-global by ADR 0003 and hosts has no project scope, so "remove, hosts" in the acceptance does not apply.
- Operator raised the risk on 2026-11-05: project-scope installs land in whatever directory agent-depot was launched from.
- Coordinator code check: `src/cli.ts:1443` resolves `projectRoot ?? process.cwd()` without walking up to a Git root or manifest; previews already print `target: <path>` (`src/skill-install.ts:261`) but give no project identity or warning.
- Packages run Host CLIs with `cwd: home` (`src/package-flow.ts:231`) and Apps are user-global, so scope is Skills only.
- Operator asked to combine the three proposals (prominent Project line, non-blocking warning, `--project`) into a new initiative: «¿se pueden combinar las 3? si iniciativa nueva». Coordinator advised against a hard gate on pre-existing `.claude/`/`.pi/` because new projects lack them.
- Worker (sonnet): RED 99a30de (tests only; worker-observed 10/11 behavioural failures), GREEN 85b2855 (src/project-target.ts describeProjectTarget: Project line, .git walk-up warning, empty-project warning; core install/update plans carry the lines; --project on install and update check/apply with exist/dir/no-symlink validation; .fallowrc zone), docs 6a2c385 (README, CHANGELOG). Self-reported reads: worker, comments, code-quality, design-principles, isswf-tdd. Worker full suite Windows: 1255 tests, fail 4 (known TUI frame timeouts). A stray worker background shell (bmdhtlpvy) was stopped by the coordinator; working tree clean.
- Coordinator at 6a2c385: build/typecheck/lint pass; project-target, cli, cli-options, tui-catalog-install, tui-updates-view: 161 pass, 0 fail, 1 skipped. Review R1 dispatched.
- Review R1 (Agent-tool isswf-reviewer, opus, not bound): Standards PASS, Spec PASS (narrowed scope), risk LOW, 0 blocking. Follow-ups: --project symlink rejection untested and throws plain Error (not CliUsageError); TUI update preview Project-line assertion; Project line repeated in multi-Skill TUI batch; no `tui --project`; Host project directory list duplicated with src/project-installation.ts:2099. Coordinator confirmed RED 99a30de touches tests/project-target.test.ts only.
- PR #87 https://github.com/iseoane/agent-depot/pull/87 at 6a2c385.
- Operator 2026-11-06: «No dejes esos 5 cosas menores para más adelante». Correction 1/1 sent to the same worker on the same branch: (1) --project symlink rejection as CliUsageError + test; (2) TUI update preview Project-line assertion; (3) Project block once per multi-Skill TUI batch; (4) `agent-depot tui --project`; (5) single source for Host project directories. PR #87 merge held until done.
- CI 42298101866 on 6a2c385: windows/pack SUCCESS; Linux check FAILURE in new tests/project-target.test.ts:146 "--project selects the project root…": "the preview writes nothing" found `.local` in the project dir (Linux only). Sent to the same worker as part of correction 1/1: diagnose real write vs test isolation; do not weaken the assertion.
- Correction 1/1 (worker hand-back report refused by host as duplicate; evidence from commits and coordinator inspection): RED fde8ee2 (tests only: project-target, tui-catalog-batch, tui-updates-view; 99 lines), GREEN 6e75584, docs ec1bb24. Items: (1) SymlinkPathError in path-safety mapped to CliUsageError for --project; (2) TUI update preview Project-line test; (3) PreparedInstall.projectTarget rendered once per batch (catalog-panel); (4) `agent-depot tui [--project <path>]`; (5) HOST_PROJECT_DIRECTORIES moved to project-manifest.ts and used by project-installation portableV1ExcludedDirectory (same set). Linux CI cause: pre-existing product bug — project-scope install called loadPackageOwnedSkillFilter with homeDirectory = project root, reading/locking Package state under <project>/.local; now skipped for project scope. Coordinator judgment: no real protection lost (the check never read the user's Package state for project installs; Packages are user-global by ADR 0009), so no extra review round. Coordinator at ec1bb24: build/typecheck/lint pass; project-target, cli, cli-options, tui-catalog-install, tui-catalog-batch, tui-updates-view, package-boundaries, project-installation: 224 pass, 0 fail, 1 skipped. Worker RED/full-suite results not received (report refused).
- CI on ec1bb24: check SUCCESS (test 1255 pass 0 fail; e2e 16 pass 0 fail), windows/pack SUCCESS, audit SKIPPED. Merged with matching head as d084afc (PR #87); branch deleted.
