# Planner proposal: TUI progress indicator

> Returned by isswf-planner (Opus 5.5, effort low, read-only) on 2026-10-28 against base main 5efc0f9. Transcribed by the coordinator. The operator then answered the open questions: braille spinner; elapsed from 1s as `12s` / `1m 05s`; inline indicators for background checks too.

The planner agreed with the coordinator's tentative decisions, with two changes. First, the start time lives in the busy mode rather than being taken at component mount. Second, turning animation off in tests also hides elapsed seconds and shows a fixed glyph.

The planner verified these lines itself: render-expanded.ts:8, isolated-env.ts, sources-mode.ts:10/19/39, updates-panel.tsx:126, profile-view.tsx:522, file-picker.tsx:144, installations-view.tsx:172, catalog-view.tsx:186, sources-view.tsx:338/382, sources-recipes.tsx:314, updates-view.tsx:55. The other lines come from the research note.

## 1. Outcome and acceptance
Every TUI wait shows a spinner, a specific English label and, from 1s on, elapsed seconds, e.g. `⠹ Installing foo… 3s`.
- **AC1:** every busy or loading state in §4 renders through `Working`, including the waits that are silent today:
  - recipe reloads (`r`, Esc/n, on mount);
  - Installations finish-reload and the App-row background check;
  - the Profile export-name check.
- **AC2:** `Working...` and `Loading Profile…` during import apply no longer appear in src/tui (checked by grep).
- **AC3:** elapsed time does not reset when the label changes within one operation (e.g. Updates Refreshing→Checking). It restarts for a new operation.
- **AC4:** no timer outlives unmount, and timers are `unref`'d.
- **AC5:** only one spinner per screen. The Updates panel and view never both render one.
- **AC6:** `pnpm typecheck`, `pnpm lint`, `pnpm test` and the TUI e2e pass.

## 2. Component design
- `src/tui/panel-parts.tsx` holds `Working`. Frames and formatting live in a pure module, `src/tui/working-model.ts`, so they can be unit-tested.
- API: `<Working label="Installing foo…" since={startedAt} now={() => number}? animate={boolean}? />`. `since` is epoch ms and required. `animate` defaults to `animationEnabled()`.
- Frames: Ink 7 has no spinner, and a dependency isn't worth it. Use braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at ~80ms. An ASCII fallback `-\|/` only if needed.
- Tick: one `setInterval` per mounted `Working`, in a `useEffect`, `unref`'d and cleared on cleanup (pattern at updates-view.tsx:53-62).
- Elapsed: `Math.floor((now() - since)/1000)`, shown only when ≥1, as `3s` or `1m 05s`. Not formatAgo, which adds an "ago" suffix.
- Why the start time lives in the mode: a mount-time start would reset on React remounts and when switching render sites (Updates panel vs view). So:
  - busy modes become `{ kind: "busy"; label: string; startedAt: number }`;
  - a helper `busy(label, prev?)` keeps `prev.startedAt` when the previous mode was already busy, so a label change keeps the start and a new operation gets `Date.now()`;
  - loading states (`state.status === "loading"`) get `startedAt` the same way.
- Clock injection: `now` prop, defaulting to `Date.now`. Views that already take `now` (Updates) pass it through.

## 3. Test seam and impact
- Seam: isolated-env.ts sets `AGENT_DEPOT_NO_ANIMATION=1`; `animationEnabled()` reads it. Optionally also false when `!process.stdout.isTTY` or `CI` is set.
- With animation off: no interval, a fixed glyph `·`, no elapsed seconds, so frames are identical to a static render.
- The frame-change waits stay deterministic and need no change: profile:338, installations:107, package-journey:130, bulk:122, render-expanded:17/21/25, catalog-view:101/412, catalog-packages:154/246, catalog-batch:73, engram-repro:117/181.
- `Working`'s own tests pass `animate`/`now` explicitly to check:
  - frames advance;
  - the 1s threshold;
  - `startedAt` survives a label change;
  - the timer is cleared on unmount.
- render-expanded.ts:8 needs a change: `startsWith("Loading")` would accept a glyph-prefixed loading frame. Replace it with an exported predicate such as `!isWorkingFrame(text)` (first line starts with a spinner glyph or `·`), or wait for a known non-loading token.
- Positive text assertions: sources:42, app:60, installations:213, catalog-view:152, updates:203/339, profile:705/711, file-picker:204/220, e2e:972-973.
  - They still pass where label text is unchanged; `toContain`/regex is unaffected by the prefix.
  - Update the assertion in the same commit wherever a label is reworded (`Working...`, `Loading Profile…`).
  - Check each for `^` anchors or equality.
- Negative regexes (app:183, updates:309) stay valid, because labels keep those words. No new label should add them in screens these tests cover.
- Layout baseline (catalog-view:267-269): `Working` is one line and fits the FieldLine slots, so the line count is unchanged. Re-run to confirm.
- e2e runs in a real PTY. It may or may not inherit the isolated-env flag; check whether its spawn env comes from `process.env`. It should match on label text, not exact frames.

## 4. Mode-type changes
- sources-mode.ts:10/19/39: `busy` gets `label` and `startedAt`.
  - The `run` call sites (sources-view.tsx:191-205) and `startRemoval` (:217-241) pass labels such as `Adding source…`, `Refreshing sources…`, `Removing <name>…`.
  - sources-view.tsx:382 renders `Working`.
- sources-recipes.tsx:45: `busy` gets a label, with a specific label at each of the 7 call sites (96, 132, 156, 173, 218, 232, 250).
  - The silent `void reload()` calls (:206, :263, :288) set a `loading` state, `Loading App recipes…`.
  - This also stops `No sources or App recipes` showing while loading (sources-view.tsx:349).
- These label-only busy types gain `startedAt`: catalog-actions.ts:43, updates-mode.ts:8, manage-actions.ts:56, app-actions.tsx:19, bulk-actions.ts:101, package-actions.tsx:36. Route every `setMode({kind:"busy",…})` through `busy()`, or a functional `setMode(prev => busy(label, prev))`.
- Updates: one render site.
  - The panel renders `Working` for every busy label.
  - The view's "Update check" Status renders `Working` only while `state.status === "loading"` and the mode is not busy. Alternatively, move the view's rendering into the panel.
  - Phase changes at updates.ts:205/215 keep `startedAt`.
- Installations:
  - The finish reload (installations-view.tsx:133-139) sets a `refreshing` flag, showing `Refreshing installations…` above the list instead of blanking it.
  - The App-row background check (:86-112) gets a `checking` substate shown inline (`Checking App status…`), non-blocking.
  - manage-panel.tsx:134-135 `<Text>{mode.label}</Text>` becomes `Working`.
- Profile:
  - busy becomes `{kind:"busy",label,startedAt}`, with labels `Loading Profile…`, `Applying import (n changes)…`, `Exporting…`.
  - existsCheck (:307-309) shows an inline `Checking name…`.
- Layout unchanged; these only switch to `Working`: catalog-view.tsx:186, catalog-panel.tsx:127, app-actions.tsx:248, file-picker.tsx:144.

## 5. Units (one worker, sequential, branch feat/tui-progress; after each: typecheck, lint, test)
1. Component and seam: working-model.ts, `Working`, isolated-env flag, render-expanded fix, tests/tui-working.test.tsx. Commit `feat(tui): add Working progress indicator`.
2. Sources and Recipes (mode types, labels, silent reloads), updating assertions in the same commit.
3. Catalog, Package and App actions; re-check the layout baseline.
4. Installations (manage/adoption/unmanaged/bulk, manage-panel, finish reload, App-row check).
5. Updates (single render site, label change keeps start, AC3 test).
6. Profile and file picker (labels, existsCheck).
7. Final: full checks, e2e, CHANGELOG, AC2 grep. Then independent review, corrections, and re-run of affected checks.

Could be split or deferred: the App-row inline check (unit 4) and existsCheck (unit 6). They are the least clear in UX terms, and mildly risky because they must not block input.

## 6. Risks and open questions
- Risks:
  - A missed setMode keeps the literal type; a required `startedAt` makes typecheck catch it.
  - e2e can be flaky with a ticking spinner, so match text only.
  - An 80ms re-render can flicker in slow terminals; go to ~120ms if needed.
  - Several `Working` on screen at once: the action wins and the background indicator is hidden.
  - Tests that snapshot mode objects must ignore `startedAt` or inject a clock; grep for `kind: "busy"`.
- Open questions (answered by the operator): elapsed format; braille vs ASCII; background indicators; English labels.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, TUI e2e (tests/e2e/tui.e2e.test.ts), and a manual PTY smoke test with animation on.
