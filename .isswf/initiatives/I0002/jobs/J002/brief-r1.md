# Job brief

## Identity and authorization

- Job ID and brief revision: I0002/J002, r1.
- Source: operator conversation 2026-10-28. The operator asked whether the e2e would use the isSWF skill; the coordinator selected an animated end-to-end journey for this feature.
- Request mode: feature-to-PR (same PR as J001).
- Permitted side effects: edit `tests/e2e/` (and test-only helpers, if needed); local commits on `feat/tui-progress`; no push.
- Profile and skills: `.agents/roles/worker.md`; follow `${PLUGIN}/.agents/skills/isswf-e2e/SKILL.md`.

## Objective

- Observable outcome: a real-PTY e2e proves that, with animation on, a slow TUI action shows an advancing spinner, shows elapsed time from 1s, and clears when done.
- Why: every other test disables animation (`AGENT_DEPOT_NO_ANIMATION=1` in isolated-env). Only isolated component tests exercise animation. The operator's complaint was a static screen.

## Scope and acceptance

- Included: `tests/e2e/tui.e2e.test.ts` (or a new e2e file next to it) and its fixtures/helpers.
- Exclusions: product code in `src/`. If the journey cannot be built without a product change, stop and report.
- Acceptance:
  1. The new journey runs the real CLI in a PTY with `AGENT_DEPOT_NO_ANIMATION` unset or `0`. It uses a deliberately slow fixture action (e.g. a fixture host or App command that sleeps ~2–3s) and asserts by text and regex, never exact frames:
     - a spinner glyph appears with the action label;
     - the glyph changes between two observations;
     - an elapsed `\d+s` appears after ≥1s;
     - the indicator disappears when the action finishes.
  2. The existing palette test waits for `fixture-app: cancelled` before sending `3` (around tests/e2e/tui.e2e.test.ts:358). This fixes the race found in A001.
  3. `pnpm test:e2e` passes 5 consecutive runs, both in default mode and with animation on for the whole e2e suite. Report the counts.
  4. `pnpm typecheck` and `pnpm lint` clean; `pnpm test` still passes.

## Independent review

- Required: yes, as part of the full I0002 candidate review after J002.

## Inputs and bases

- Target base: feat/tui-progress at 74efd89 (J001 candidate plus records).
- References: jobs/J001/A001.md (e2e race diagnosis); the worker's scratchpad helper `animate-on.mjs` (sets the env flag to 0 via `--import`) may be reused as a pattern.

## Execution

- Requested model and effort: Sonnet 5.5 / high.
- Commit policy: one commit, `test(e2e): ...`. No attribution lines of any kind.
- Budget: one pass; report blockers rather than widening scope.
