> Researcher (isswf-researcher, Haiku 5.5, high, read-only) report as condensed by the coordinator and handed to the planner, 2026-10-28, base 5efc0f9.

# Researcher report (Haiku, read-only, base 5efc0f9) — TUI wait points

Facts with paths/lines as reported; verify before relying on them.

## Busy/loading renders (static text today)
- Sources: sources-view.tsx:338 `Loading sources...` (BorderPanel "Sources", FieldLine Status); sources-view.tsx:191-205 `run` and :217-241 `startRemoval` → generic `Working...` at :382. sources-mode.ts:10 busy has NO label.
- Recipes: sources-recipes.tsx:96,132,156,173,218,232,250 → `Working...` (BorderPanel "App recipe workflow" :314); sources-recipes.tsx:45 busy NO label.
- SILENT (nothing shown): sources-recipes.tsx:263 (`r` → void reload()), :206 (Esc/n → void reload()), :288 (mount reload; may show "No sources or App recipes" while loading, sources-view.tsx:349).
- Catalog: catalog-view.tsx:186 `Loading catalog...` (plain Text, replaces view); catalog-flow.ts:38,59 → catalog-panel.tsx:127 BorderPanel "Skill install"; package-actions.tsx:61,70,87,102,137,151,170 → catalog-panel.tsx:127 or manage-panel.tsx:134-135; app-actions.tsx:125,155,178,237 → app-actions.tsx:248 BorderPanel "App lifecycle".
- Installations: installations-view.tsx:172 `Loading installations...` (mount only; finish reload :133-139 sets no loading state). SILENT: installations-view.tsx:86-112 background approvalStatus/inspect on App row highlight. manage-actions.ts:113,142,199,204,209; adoption-actions.ts:47,69,80; unmanaged-actions.ts:164,188; bulk-actions.ts:291,340 → manage-panel.tsx:134-135 bare `<Text>{mode.label}</Text>` (no border).
- Updates: updates-view.tsx:151 BorderPanel "Update check" FieldLine Status `Refreshing sources...`/`Checking for updates...` (updates-model.ts:3-4, phases updates.ts:205,215). updates-panel.tsx:125-127 hides REFRESHING/CHECKING, shows other labels (`Preparing preview...`, `Applying updates...`, `Checking App version...`, `Continuing updates...`) — two render sites must be unified to avoid double spinner. updates-view.tsx:53-62 has a 10s setInterval clock (unref, cleared) with injectable `now`.
- Profile: profile-view.tsx:522 `Loading Profile…` for ALL busy cases incl. applying an import (installs/uninstalls) — misleading. SILENT: profile-view.tsx:307-309 existsCheck on export name.
- File picker: file-picker.tsx:144 muted `Loading…`.
- Busy mode types carry only `label: string`: catalog-actions.ts:43, updates-mode.ts:8, manage-actions.ts:56, app-actions.tsx:19, bulk-actions.ts:101, package-actions.tsx:36.
- Labels persist across sub-steps; elapsed time should be keyed to the operation, not each setMode.

## Shared pieces
- panel-parts.tsx: BorderPanel, FieldLine, DecisionPrompt, ... no spinner. theme.ts palette only. updates.ts:282-289 formatAgo (wrong suffix for elapsed).
- No ink-spinner/cli-spinners dependency. Deps: ink ^7.1.1, react ^19.3.0, ink-testing-library ^4.0.0.

## Tests (risk)
- Harness: ink-testing-library lastFrame/stdin; tests/wait-for-frame.ts (5ms poll, 5s timeout); tests/render-expanded.ts; E2E in PTY tests/e2e/tui.e2e.test.ts.
- Text assertions: tui-sources-view.test.tsx:42, tui-app.test.tsx:60, :183 (negative /Loading|Checking|Refreshing/), tui-installations-view.test.tsx:213, tui-catalog-view.test.tsx:152, tui-updates-view.test.tsx:203,309(negative),339, tui-profile.test.tsx:705,711, tui-file-picker.test.tsx:204,220, render-expanded.ts:8 (`!text.startsWith("Loading")` — a spinner prefix would make this pass while still loading!), e2e tui.e2e.test.ts:972-973.
- Frame-change waits (`frame !== before`) that a ticking spinner breaks: tui-profile.test.tsx:338, tui-installations-view.test.tsx:107, tui-package-journey.test.tsx:130, tui-installations-bulk.test.tsx:122, render-expanded.ts:17,21,25, tui-catalog-view.test.tsx:101,412, tui-catalog-packages.test.tsx:154,246, tui-catalog-batch.test.tsx:73, engram-app-version-repro.tsx:117,181.
- Layout compare: tui-catalog-view.test.tsx:267-269 (line count / indexOf vs baseline).
- No fake timers in TUI tests. tests/isolated-env.ts is loaded via --import for every test run.

## CLI (out of scope for this unit, noted)
Non-TUI commands (install, update, package install, app, profile import, source add/refresh, self update) are silent during long work; child stdout is ignored unless captured.
