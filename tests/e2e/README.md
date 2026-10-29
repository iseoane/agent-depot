# TUI end-to-end tests

`tui.e2e.test.ts` drives the built CLI (`dist/src/cli.js tui`, and one non-TUI command) inside a real pseudo-terminal with an
isolated HOME, XDG and Pi state. Run it with `pnpm test:e2e`. Every journey is named by its test title.

Every test process starts from `tests/isolated-env.ts`, which sets `AGENT_DEPOT_NO_ANIMATION=1` so Working
renders one static frame. A journey that needs the real spinner must set `AGENT_DEPOT_NO_ANIMATION: "0"`
for its own session.

| Journey | Test | Preconditions | Expected result | Coverage limit |
| --- | --- | --- | --- | --- |
| Slow action shows live progress | `a slow App install shows an advancing spinner, elapsed time from 1s, and clears when done` | Fixture App recipe, approved, whose install holds for 2.5s (`--sleep-ms=2500`); animation on | A braille glyph with the busy label appears and changes; elapsed `Ns` first appears at least 1s after confirming and never goes backwards; the busy line is gone after `fixture-app: installed` | Matches text and regex only, never exact frames. Covers the App install path; other busy labels are covered by component tests. No visual flicker check. |
| Slow CLI command shows live progress | `a slow CLI command shows a spinner with elapsed time on a terminal and erases it before the result` | Same fixture App recipe, approved, install held for 2.5s; runs `app install fixture-app --yes` (no TUI) on the PTY; animation on | A braille glyph with `Installing App fixture-app…` appears and advances; elapsed `Ns` first appears at least 1s in and never goes backwards; the preview lines stay above the spinner; after exit the screen holds `fixture-app: installed` and no spinner glyph or label | Matches text and regex only, never exact frames. Covers the animated stderr path of one command; the non-TTY line, `AGENT_DEPOT_NO_ANIMATION=1` and the other commands' labels are covered by `progress.test.ts` and `cli-progress.test.ts`. |
| Child output tail on the spinner | `a slow CLI command shows the last three child lines under the spinner and erases them with it` | Same fixture App, approved; install prints five numbered lines (alternating stdout and stderr, 60ms apart) then holds 2.5s; runs `app install fixture-app --yes` on the PTY (100x24); animation on | While the spinner runs, `build step N` lines sit directly under its row, never more than three, with the preview still above; the newest frame shows steps 3 to 5; after exit the screen holds `fixture-app: installed` and no spinner, label or `build step` line | Matches text only, and the emulator's erase-to-end-of-screen support was added for it. `mayPrompt` suppression, width truncation and the non-TTY paths are covered by `child-output.test.ts`. No Windows run (skipped). |
| No tail without a terminal; `--verbose` streams | `without a terminal child output stays hidden, and --verbose streams it to stderr only` | Same fixture App on pipes, run twice in fresh sandboxes: plain, then with `--verbose` | Plain: stderr is exactly `Installing App fixture-app…` and stdout has the result and no child line. `--verbose`: stdout is byte-identical to the plain run (sandbox path scrubbed); stderr is the step line then the five lines (as a set, because stdout and stderr are separate pipes) | One command and the App path only; npm, pi and git steps are covered by unit tests with real child processes. |
| Long Package approval pages in a short terminal | `a long Package approval pages inside a short real terminal and never hides what it asks to approve` | Real `pstack` fixture repository added and refreshed as a Source through the CLI; HOME under a deliberately long directory so the working directory wraps; stand-in `pi`/`claude` on PATH; 60x16 PTY | In the Catalog `i` on the `pi` Package opens a panel whose every screen keeps the header, `Review N of M` and the bottom border; `y` before the last row changes nothing; PgDn reaches `Approve this declaration and continue? y/n`; the rebuilt rows contain the whole working directory, the argv step and the approval status; `n` cancels without writing host state | Stops at `n`, so the install and approval writes are covered by `tui-package-journey.test.tsx` and `tui-packages.test.tsx`. Not run on Windows. Catalog route only; the Installations route (Enter approve, forget) is covered by `tui-packages.test.tsx`. |

To run the whole suite with animation on, load the override after `isolated-env` (the last `--import` wins):

```sh
pnpm build && node --import ./dist/tests/isolated-env.js --import ./animate-on.mjs --test --test-timeout=120000 "dist/tests/e2e/*.e2e.test.js"
```

where `animate-on.mjs` contains `process.env.AGENT_DEPOT_NO_ANIMATION = "0";`.
