# I0019: Make the project-scope target explicit and safe

Type: improvement

## J001
- Status: ready
- Objective: Make every project-scope Skill operation show, sanity-check and optionally select the project root, instead of silently using the current working directory.
- Depends on: None
- Blocker: None
- Next step: Operator authorizes implementation start (worker, focused tests under isolated-env, independent review, PR).

### Acceptance
- Every `--scope project` preview (CLI and TUI: install, remove, update, hosts) starts with a prominent `Project: <absolute path>` line, produced by the shared core flows (ADR 0006), not by views.
- Non-blocking warning in the preview when the project root is inside a Git repository but not its top level (naming the Git top level), or has no project manifest and no Host project directory (`.claude/`, `.pi/`, ...). A brand-new project must still be installable; no hard block.
- CLI `--project <path>` selects the project root explicitly; path is resolved, must exist and be a directory, and goes through `path-safety.ts`. Default remains the current working directory (backward compatible).
- TUI shows the active project root (header or project-scope preview).
- Focused regressions: cwd default, subdirectory-of-repo warning, empty new project allowed with warning, existing manifest no warning, `--project` valid/invalid paths, no writes on cancel; state paths injected and isolated-env loaded.
- Docs (README project-scope section) updated.

### Evidence
- Operator raised the risk on 2026-11-05: project-scope installs land in whatever directory agent-depot was launched from.
- Coordinator code check: `src/cli.ts:1443` resolves `projectRoot ?? process.cwd()` without walking up to a Git root or manifest; previews already print `target: <path>` (`src/skill-install.ts:261`) but give no project identity or warning.
- Packages run Host CLIs with `cwd: home` (`src/package-flow.ts:231`) and Apps are user-global, so scope is Skills only.
- Operator asked to combine the three proposals (prominent Project line, non-blocking warning, `--project`) into a new initiative: «¿se pueden combinar las 3? si iniciativa nueva». Coordinator advised against a hard gate on pre-existing `.claude/`/`.pi/` because new projects lack them.
