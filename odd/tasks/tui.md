# Feature: Agent Depot TUI

## Objective
Add an interactive terminal UI (`agent-depot tui`) to manage visually what the CLI does.

## Why
The CLI requires remembering subcommands, ids and `--yes` confirmations; a TUI makes sources, catalog, installations and updates browsable.

## Scope / order (agreed with user 2026-09-30)
1. Sources view (list, add Git Source, refresh, remove) — foundation for the rest.
2. Catalog view (sources → discovered skills, filter).
3. Installations view (host × scope, adopt) — later.
4. Updates view (update batch, multi-select) — later.

## Constraints
- Library: Ink (React for terminal) + `ink-testing-library` for tests. First runtime dependencies; accepted by user.
- TUI lives in `src/tui/`, calls `SourceOperations` (`src/sources.ts`) directly; never parses CLI output.
- Destructive actions (refresh, remove) require an explicit confirmation step, mirroring CLI `--yes` previews.
- Built-in source cannot be refreshed/removed (same rule as CLI `BuiltInSourceError`).
- `runCli` stays the entry point: `tui` is a new entry in `COMMANDS`.

## TDD
- Mode: enabled (session config, Strict TDD). Runner: `pnpm test` / `pnpm test:single tests/<file>.test.ts` (node:test on compiled `dist`).

## Tasks
- [x] T1 — Ink scaffolding: deps, tsconfig JSX, `agent-depot tui` command launching an app shell with injectable `SourceOperations`; test renders shell.
- [x] T2 — Sources view: list sources (id, kind, url), keyboard navigation, empty/error states.
- [x] T3 — Sources actions: add Git Source (URL input), refresh and remove with confirmation; built-in protected.
- [x] T4 — Catalog view: select source(s) → discovered skills with filter.
- [x] T5 — Hardening from independent review of main..c4eeb79 (all minor): `q` may quit mid-operation (capturing state lags via useEffect); selection tracked by index instead of source id after reload; setState after unmount without isMounted guard. Done: capture state now synchronous (ref updated with each mode/filter dispatch), highlight follows source id, mounted guard on async paths; RED 4 new tests, GREEN 35 tui tests.
- [x] T6 — Core+CLI: extract single user-global managed Skill removal (inspect, preview, recheck, remove files, reconcile records; adopted/modified warnings) from `src/cli.ts` into a shared module; new `agent-depot skill remove <id|path> [--yes]`. User-global only (project removal explicitly out of scope, user decision 2026-09-30).
- [x] T7 — TUI Catalog: installed status marker (hosts per scope), `i` install (multi-select hosts, scope, version policy, preview+confirm, separate additional-host confirmation) and `u` uninstall user-global via T6 module (preview+confirm, warnings, whole installation); no uninstall for project scope.

## Acceptance criteria
- `agent-depot tui` opens, shows sources, and supports add/refresh/remove with confirmation.
- All tests, `pnpm lint`, `pnpm typecheck` pass.

## Progress
- Branch: `feat/tui-sources`. Route: delegated direct (writer trigger: 2+ non-trivial files).
- Node minimum raised to >=24 (Active LTS) because Ink 7 requires Node >=22; @types/node ^24.

## Evidence
- T1: RED = `pnpm typecheck` failed (missing `src/tui/app.js`, `renderTui` not in `CliDependencies`); GREEN = typecheck, lint, test (246 pass) all clean. Route: delegated direct writer. Added `ink`, `react`, `@types/react`, `ink-testing-library`; `src/tui/app.tsx`, `src/tui/render.tsx` (lazy-imported by `tui` command); usage test updated. Commit: see git log (`feat(tui): scaffold Ink app and tui command`).
- T2: RED = typecheck failed (no `src/tui/sources-view.js`, `isInteractive` not in `CliDependencies`); GREEN = typecheck, lint, test (252 pass) clean; `echo q | node dist/src/cli.js tui` prints `Error: agent-depot tui requires an interactive terminal`, exit 1. Added `src/tui/sources-view.tsx`, injectable `isInteractive` guard, `tests/tui-sources-view.test.tsx`. Route: delegated direct writer.
- T3: RED = new `tests/tui-sources-actions.test.tsx` failed on the old view (no `a add` footer, no URL input/confirmations); GREEN = typecheck, lint, test (263 pass, 3 consecutive runs) clean. Added `src/tui/sources-mode.ts` (mode reducer: browse/input/confirm/busy), actions in `sources-view.tsx`, `onCapturingChange` so `q` quits only in browse mode, key-hint footer in `app.tsx`. Remove safety: TUI never offers dependent-installation choices; if any user-global installation depends on the source (same predicate as CLI), it blocks and points to `agent-depot source remove <id>`; missing `removeGitSource`/`listUserGlobalInstallations` -> "not supported". Route: delegated direct writer.
- T4: RED = `tests/tui-catalog-view.test.tsx` failed to compile (no `src/tui/catalog-view.js`); GREEN = typecheck, lint, test (275 pass, 2 runs) clean. Added `src/tui/catalog-view.tsx`, `src/tui/catalog-filter.ts` (filter reducer + case-insensitive name/description match), view switching (`1`/`2`) in `app.tsx`, Enter on a source opens its catalog, `s` toggles all sources, `/` filter with "n of m". Missing `discoverSkills` -> "not supported". Route: delegated direct writer.
- T6: RED = 4 new `skill remove` tests in `tests/cli.test.ts` failed (usage error, command unknown); GREEN = typecheck, lint, test (284 pass) clean, existing source remove/uninstall tests unchanged. Added `src/skill-removal.ts` (selectUserGlobalSkills, planSkillRemoval, inspectSkillRemovals, recheckSkillRemoval, executeSkillRemoval, removeSkillFiles, removeSkillsAndRecords, describeSkillRemoval, userGlobalRemovalOptions); `source remove` and `uninstall --skills` refactored onto it. Ids match exact path or unique final segment. Route: delegated direct writer.
- T7: two work-unit commits. (1) `refactor(install)`: extracted the single-Skill install flow (select, resolve, inspect, preview, collision checks, install, persist with rollback, external method) from `src/cli.ts` into `src/skill-install.ts` (`planSingleInstall`, `outputSingleInstallPreview`, `executeSingleInstall`, `needsAdditionalHostExposure`, `isValidFixedVersion`), `CliUsageError` moved to `src/usage-error.ts`; CLI behavior unchanged (284 existing tests green before and after). (2) TUI: RED = `tests/tui-catalog-install.test.tsx` failed to compile (no `src/tui/environment.js`, no `environment` prop); GREEN = typecheck, lint, test (298 pass). Added `src/tui/environment.ts` (injectable home, project root, source access, manifest store), `src/tui/catalog-installs.ts` (markers, prepare/run install, prepare/run uninstall), `src/tui/catalog-actions.ts` (action mode), `catalog-view.tsx` (`i`/`u`, checklist hosts with space/1-4/j/k/Enter, scope, version incl. fixed text, preview, y/n, busy). Marker `[global: claude, codex] [project: pi]`; missing optional operations -> no marker. Install previews reuse the CLI preview (external method argv shown; `confirmation:` CLI wording dropped) and the TUI confirmation stands in for `--portable-v1`. An adoption that must add a missing Host location shows an ADDITIONAL HOST EXPOSURE warning and needs a second y/n (CLI `--confirm-additional-host`). An already-recorded Skill is rejected as in the CLI (change via update apply). `u` removes the whole user-global installation (preview lists hosts), project-only shows "Project uninstall is not supported". Overwrite is not offered in the TUI. Route: delegated direct writer.

## Next step
T3/T4 complete; Installations view (host × scope, adopt) is the next scope item, pending user go-ahead.
