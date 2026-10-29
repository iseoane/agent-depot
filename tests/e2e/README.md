# TUI end-to-end tests

`tui.e2e.test.ts` drives the built CLI (`dist/src/cli.js tui`) inside a real pseudo-terminal with an
isolated HOME, XDG and Pi state. Run it with `pnpm test:e2e`. Every journey is named by its test title.

Every test process starts from `tests/isolated-env.ts`, which sets `AGENT_DEPOT_NO_ANIMATION=1` so Working
renders one static frame. A journey that needs the real spinner must set `AGENT_DEPOT_NO_ANIMATION: "0"`
for its own session.

| Journey | Test | Preconditions | Expected result | Coverage limit |
| --- | --- | --- | --- | --- |
| Slow action shows live progress | `a slow App install shows an advancing spinner, elapsed time from 1s, and clears when done` | Fixture App recipe, approved, whose install holds for 2.5s (`--sleep-ms=2500`); animation on | A braille glyph with the busy label appears and changes; elapsed `Ns` first appears at least 1s after confirming and never goes backwards; the busy line is gone after `fixture-app: installed` | Matches text and regex only, never exact frames. Covers the App install path; other busy labels are covered by component tests. No visual flicker check. |

To run the whole suite with animation on, load the override after `isolated-env` (the last `--import` wins):

```sh
pnpm build && node --import ./dist/tests/isolated-env.js --import ./animate-on.mjs --test --test-timeout=120000 "dist/tests/e2e/*.e2e.test.js"
```

where `animate-on.mjs` contains `process.env.AGENT_DEPOT_NO_ANIMATION = "0";`.
