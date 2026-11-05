## Why the change

The 0.6.9 publication workflow stopped at its architecture audit: the new Source snapshot helper from #76 had no matching boundary zone. Publication and tagging were skipped. This fixes the missing declaration, not the auditor or Windows tests.

## Change outline

Register exactly `src/source-snapshot.ts` in the existing **infrastructure** zone beside its Git/process owners. No new wildcard, exception, allowed dependency or disabled check. All boundary rules and `requireAllFiles: true` remain unchanged. No runtime, test, dependency, workflow or version changes.

Base: `53399dde250732b2f35996bc02977052ebd6ed90`; head: `62ec30eca2904cfc8bbd6b0d46693e46f5a0c837`.

## Risk assessment

**Low for this one-line declaration.** Incorrect ownership could misclassify dependency edges. The helper implements Git byte framing and immutable snapshot reuse, is imported by `git-source.ts`, and its only source import is a type from the same infrastructure owner. Exact registration applies the existing rules rather than relaxing them. A structural JSON equality check verifies that nothing else changed.

The configured remote architecture audit must verify this classification before release; local fallow is unavailable and was not installed. Failures remain visible. Reverting this line restores the known audit failure and does not change application data. No live rollback is claimed. Unchanged runtime retains #76's independent review; no new independent runtime review is claimed for this mechanical configuration delta.

## Testing

- Observed failure: [publish run 41906554267](https://github.com/iseoane/agent-depot/actions/runs/41906554267), `src/source-snapshot.ts:1 no matching boundary zone`; full tests and E2E passed before the audit. `publish` and `tag` were skipped.
- Local JSON deep-equality proof: only the exact infrastructure pattern is added; all rules and coverage settings unchanged. `git diff --check`: pass.
- No retrospective TDD claim for this declaration maintenance; the existing auditor supplied the observed failure.
- Exact-head PR CI and explicit existing CI workflow-dispatch audit: pending. The audit job is advisory in the existing workflow, so its actual results must be inspected rather than inferred from overall CI status.
- Existing Windows CI for #77 passed on its second attempt; its initial unrelated concurrent App-receipt rename failure remains recorded there.
