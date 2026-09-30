# Ink and React for the TUI

Status: Accepted (2026-09-30)

## Context

The interactive TUI needs a component model, focus and input handling, and testable rendering. Until now the package had no runtime dependencies.

## Decision

Use Ink with React for `agent-depot tui`, tested with `ink-testing-library`. They are the first runtime dependencies. The TUI entry point is imported lazily (`await import("./tui/render.js")`) only by the `tui` command.

## Consequences

- Non-TUI commands do not load Ink or React, so their startup cost is unchanged.
- The package now has a dependency surface to keep updated.
- Ink 7 requires a recent Node, see [ADR 0002](0002-node-24-lts-minimum.md).
- Ink delivers several characters written at once as one input string, so the TUI splits plain printable chunks into single key presses (`src/tui/keys.ts`).
