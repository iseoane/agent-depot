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
- [ ] T2 — Sources view: list sources (id, kind, url), keyboard navigation, empty/error states.
- [ ] T3 — Sources actions: add Git Source (URL input), refresh and remove with confirmation; built-in protected.
- [ ] T4 — Catalog view: select source(s) → discovered skills with filter.

## Acceptance criteria
- `agent-depot tui` opens, shows sources, and supports add/refresh/remove with confirmation.
- All tests, `pnpm lint`, `pnpm typecheck` pass.

## Progress
- Branch: `feat/tui-sources`. Route: delegated direct (writer trigger: 2+ non-trivial files).
- Node minimum raised to >=24 (Active LTS) because Ink 7 requires Node >=22; @types/node ^24.

## Evidence
- T1: RED = `pnpm typecheck` failed (missing `src/tui/app.js`, `renderTui` not in `CliDependencies`); GREEN = typecheck, lint, test (246 pass) all clean. Route: delegated direct writer. Added `ink`, `react`, `@types/react`, `ink-testing-library`; `src/tui/app.tsx`, `src/tui/render.tsx` (lazy-imported by `tui` command); usage test updated. Commit: see git log (`feat(tui): scaffold Ink app and tui command`).

## Next step
T2.
