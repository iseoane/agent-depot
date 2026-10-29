# Job brief

## Identity and authorization
- Job: I0007/J001, r1. Source: operator, 2026-10-29. Mode: feature-to-PR.
- Side effects: edit `src/` CLI modules, a new shared helper, `tests/` (incl. `tests/e2e/`), `CHANGELOG.md`; one or more local commits on `feat/44-cli-progress`; no push.
- Skills: isswf-tdd for the helper; isswf-e2e for the PTY journey.

## Objective
GitHub issue #44 (`gh issue view 44`): non-TUI commands print nothing during long work. Line references in the issue are from an old base (5efc0f9): re-locate every silent path on current main before changing it.

## Design (from the issue)
- Shared helper, e.g. `withProgress(label, fn)`, reusing `src/tui/working-model.ts` (frames, `formatElapsed`, `AGENT_DEPOT_NO_ANIMATION`) — do not duplicate it; move shared pieces to a non-TUI module only if import direction requires it.
- Interactive stderr: braille spinner + label + elapsed from 1s, as in the TUI. Clear the line before results/errors print.
- Non-TTY stderr: one plain line per step, no animation.
- `AGENT_DEPOT_NO_ANIMATION=1`: static output.
- stderr only; stdout byte-identical for every command (JSON stays parseable).
- Timers unref'd; nothing outlives the wrapped promise (success or throw).
- Excluded: streaming child-process output (tracked in #52).

## Acceptance
1. Every path listed in #44 that still exists shows progress on a TTY and one line per step otherwise. Report a table: path → label → file:line.
2. stdout unchanged: tests capture stdout for representative commands (incl. a JSON one) before/after.
3. Unit tests for the helper: TTY vs non-TTY, NO_ANIMATION, clearing on success and on throw, no leaked timers.
4. One PTY e2e covers a slow command (fixture delay) showing spinner/elapsed and clearing.
5. Interactive prompts/previews (e.g. `--yes`-less confirmations) are never overwritten by a spinner: no spinner active while waiting on user input.
6. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` pass; CHANGELOG entry under Unreleased.

## Execution
- Sonnet 5.5 / high. Conventional commits (`feat(cli): ...`), no attribution lines of any kind.
- Report to `.isswf/initiatives/I0007/jobs/J001/A001.md`; stop and report if scope is much bigger than one unit.
