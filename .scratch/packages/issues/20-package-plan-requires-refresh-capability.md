# 20: Package lifecycle planning can skip the required Source refresh

**What is wrong:** `planLifecycle` calls `refreshSourceFor`, but `refreshSourceFor` silently falls back to the resolved Source when `SourceOperations.refreshProjectSource` is unavailable. ADR 0004 requires a Source refresh before any preview that can lead to a write.

**User impact:** An embedded environment can show and approve a Package lifecycle plan from stale Source content without any error.

**What ships now:** `refreshSourceFor` returns a built-in Source unchanged and throws `PackagePlanError` for any other Source when the environment exposes no `refreshProjectSource`. `planLifecycle` is the only operation that refreshes, so the preview a caller can approve is always derived from a fresh snapshot.

**For the CLI and TUI waves:** `planLifecycle` now fails closed in an environment without refresh capability, so the caller that previews a lifecycle must surface that `PackagePlanError` instead of a plan. No such caller exists yet; `src/package-cli.ts` (issue 10) and the TUI Package action path (issue 12) own it.

**Status:** completed

- [x] External Package lifecycle planning fails closed when the environment cannot refresh project Sources.
- [x] The built-in Source remains exempt from refresh.
- [x] A regression test covers an external Source with no refresh capability.

## Verification

- `tests/package-flow.test.ts`: `planning a lifecycle write fails closed when an external Source cannot be refreshed`.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/package-flow.test.ts.
