# 18: Updates can succeed with unknown observed version evidence

**What is wrong:** `recordOutcome` accepts an update when the final host state is `installed` and `sameInstalledEvidence` returns false. For an unversioned Pi git package, both the previous and observed states are installed with no version evidence. The comparison returns false, so the update is reported as `updated` even though Agent Depot cannot verify that anything changed.

**User impact:** A Package update can look successful while the host provides no version or commit evidence for the change.

**What ships now:** `installedEvidenceChange` returns `changed`, `unchanged`, or `unknown`. An update records only when the two observations agree on a version or a hexadecimal commit and differ, or when the host went from nothing installed to installed. Two installed observations with no comparable evidence return `failed` and leave the record untouched.

**Status:** ready-for-agent

- [x] Update outcomes distinguish `changed`, `unchanged`, and `unknown` evidence.
- [x] Unknown evidence returns `failed` and leaves the record untouched.
- [x] A regression test covers an unversioned Pi update.

## Verification

- `tests/package-flow.test.ts`: `an update with unknown observed version evidence fails and leaves the record untouched`.
