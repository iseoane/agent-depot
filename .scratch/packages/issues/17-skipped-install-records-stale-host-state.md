# 17: Skipped installs can record stale host state

**What is wrong:** A plan can set `skipExecution` because the host state reports the Package installed, but `completeSkipped` writes the selection before validating the live host state it returns. If the host state changes to absent or unknown between the fresh plan and the skipped completion, Agent Depot can still return `installed` and write a record.

**User impact:** Agent Depot can track a Package that is no longer verifiably installed.

**What ships now:** a skipped install routes through `recordOutcome`, which re-observes the host state before writing and records only when that observation reports the bundle installed. Absent or unknown evidence returns `failed` and leaves the selection record untouched.

**Status:** ready-for-agent

- [x] Skipped installs re-observe the host state before writing a selection record.
- [x] Unknown or absent evidence returns `failed` and leaves the record untouched.
- [x] Regression tests cover absent and unknown live rechecks.

## Verification

- `tests/package-flow.test.ts`: `a skipped install fails if the live recheck is absent`.
- `tests/package-flow.test.ts`: `a skipped install fails if the live recheck is unknown`.
