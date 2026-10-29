# Job brief

## Identity and authorization
- Job: I0005/J001, r1. Source: operator, 2026-10-29. Mode: bug-to-PR.
- Side effects: edit `src/tui/sources-recipes.tsx` (and closely related TUI code if needed) and `tests/`; one local commit on `fix/45-recipes-reload-race`; no push.
- Skill: follow isswf-debug for the diagnosis.

## Objective
GitHub issue #45 (`gh issue view 45`). CI failed once with `ENOTEMPTY ... rmdir .../state` in "recipe guide captures global number and quit keys in the shell" (`tests/tui-sources-recipes.test.tsx`). Hypothesis: Esc triggers a fire-and-forget `void reload()` (`src/tui/sources-recipes.tsx:212`; also `:269`, `:297`) that writes into the state dir while teardown removes it. Confirm or refute with evidence before fixing.

## Acceptance
1. Root cause stated with evidence (reproduction, e.g. by delaying reload, or a convincing code trace).
2. Prefer a product fix: after unmount, in-flight reloads stop writing state / setting state (abort or ignore stale results), and/or the test waits for the reload to settle before cleanup. Explain the choice.
3. A regression test or a deterministic reproduction that fails before and passes after, if feasible.
4. `tests/tui-sources-recipes.test.tsx` passes 20 consecutive runs (report count). Use `pnpm test:single` only if it works for .tsx (it does not, see #48); otherwise build and run `node --import ./dist/tests/isolated-env.js --test dist/tests/tui-sources-recipes.test.js`.
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass. CHANGELOG entry only if user-visible.

## Execution
- Sonnet 5.5 / high. One commit `fix(tui): ...`, no attribution lines of any kind.
- Report to `.isswf/initiatives/I0005/jobs/J001/A001.md`: root cause, changes, run counts, what was not done.
