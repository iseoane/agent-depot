> Brief handed to the worker (r1), 2026-10-28. Authorization: operator conversation (feature request + answers on spinner, elapsed and background indicators). Requested model: worker Sonnet 5.5/high. Delivery: branch feat/tui-progress → PR to main, no merge. Local commits authorized for the worker; no push.

# Brief: TUI progress indicator (ready to execute)

Base: main 5efc0f90168c2895e7a17bcec366dbf7ba44adf5. Branch: feat/tui-progress (checkout /home/iseoane/Work/agent-depot).
Inputs: researcher map at scratchpad/progress-research.md (same directory as this file). Plan by isswf-planner (Opus), summarized here with operator decisions.

## Outcome
Every TUI wait shows a spinner, a specific English label and, from 1s on, elapsed time, e.g. `⠹ Installing foo… 3s`.

## Operator decisions (final)
- Spinner: braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, ~80ms (raise to ~120ms only if flicker is observed). No new dependency.
- Elapsed: hidden under 1s; then `12s`, `1m 05s`.
- Non-blocking background checks also get an inline indicator: App-row status check in Installations, export-name existence check in Profile. Must not block keys.
- Labels in English (TUI language).
- Non-TUI CLI silence is OUT of scope.

## Acceptance
- AC1: every busy/loading state in the research map renders through `Working`, including currently silent waits: recipe reloads (`r`, Esc/n, mount), Installations finish-reload and App-row background check, Profile export-name check.
- AC2: `Working...` and `Loading Profile…`-during-import-apply no longer appear in src/tui (grep).
- AC3: elapsed does not reset when the label changes within one operation (e.g. Updates Refreshing→Checking); it restarts for a new operation.
- AC4: no timer outlives unmount; timers are `unref`'d.
- AC5: one spinner per screen (Updates panel and view never both render one; an action hides a background indicator).
- AC6: pnpm typecheck, pnpm lint, pnpm test, and the TUI e2e test (pnpm test:e2e, or at least tests/e2e/tui.e2e.test.ts) pass.

## Design
- `src/tui/working-model.ts` (pure): frames, `formatElapsed(ms)`, `animationEnabled()` (false when `AGENT_DEPOT_NO_ANIMATION=1`).
- `Working` in `src/tui/panel-parts.tsx`: `<Working label since={startedAt} now? animate? />`. One `setInterval` in `useEffect`, unref'd and cleared, following the updates-view.tsx:53-62 pattern. With animation off: fixed glyph `·`, no interval, no elapsed, so frames are static.
- The start time lives in the mode/state, not in component mount: busy modes become `{ kind: "busy"; label: string; startedAt: number }`. A helper `busy(label, prev?)` keeps `prev.startedAt` when the previous mode was already busy. Loading states carry `startedAt` too. `now` is injectable (Date.now by default).
- Test seam: tests/isolated-env.ts sets `AGENT_DEPOT_NO_ANIMATION=1`. Working's own tests pass `animate`/`now` explicitly. Check whether the e2e PTY harness inherits the env; e2e must match on label text, never exact frames.
- tests/render-expanded.ts:8 `!text.startsWith("Loading")` must change (a glyph prefix would pass it while still loading). Use an exported predicate such as `isWorkingFrame(text)`, or wait for a known non-loading token.

## Units (sequential; after each: pnpm typecheck && pnpm lint && pnpm test, then commit)
1. Component + seam: working-model.ts, Working, isolated-env flag, render-expanded fix, tests/tui-working.test.tsx (frame advance, 1s threshold, startedAt kept across label change, timer cleared on unmount). Commit `feat(tui): add Working progress indicator`.
2. Sources + Recipes: label + startedAt on sources-mode.ts and sources-recipes.tsx busy; specific labels at every call site; silent reloads get a loading state (also stops "No sources or App recipes" flashing while loading); sources-view.tsx:338/382, sources-recipes.tsx:314.
3. Catalog, Package and App actions: catalog-actions.ts, catalog-flow.ts, package-actions.tsx, app-actions.tsx, catalog-view.tsx:186, catalog-panel.tsx:127. Re-check the layout baseline at tui-catalog-view.test.tsx:267-269.
4. Installations: manage/adoption/unmanaged/bulk actions; manage-panel.tsx:134-135 becomes Working; finish reload shows `Refreshing installations…` above the list; App-row background check inline (`Checking App status…`), non-blocking.
5. Updates: a single render site; label changes keep startedAt; AC3 test.
6. Profile + file picker: specific labels (`Loading Profile…`, `Exporting…`, `Applying import…`); existsCheck inline `Checking name…`; file-picker.tsx:144.
7. Final: full checks + e2e, CHANGELOG entry under [Unreleased], AC2 grep.

## Risks
- A missed setMode site: making startedAt required lets the typecheck find it.
- Tests that compare mode objects: grep tests for `kind: "busy"`.
- Update positive text assertions in the same commit as any label rewording (list in the research map). Negative regexes (tui-app.test.tsx:183, tui-updates-view.test.tsx:309) must stay valid.
