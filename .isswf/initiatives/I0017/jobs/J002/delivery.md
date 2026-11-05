# I0017/J002 delivery

## What changed and why
Versioned Claude uses literal cache-version policy for update eligibility and successful lifecycle completion, manifest.version overrides entry metadata, Pi and unversioned commit policy remain conservative. Current Host evidence and version+commit displayed in CLI/TUI; same-version Claude source changes explained without false actionable update. Operator explicitly selected isSWF reviewer/canonical procedure and removed supporting code-review prerequisite in project instructions. No live install/state/config changes or release.

## Visual summary
Observed isolated UI assertion: version1.6.1+aaaaaaa ->version1.6.1+bbbbbbb rather than stored1.0.0->1.6.1. This is test fixture evidence, not a screenshot/runtime Host verification.

## Checks and results
Source candidate36aa236e515863912f12e7c1ac9a2c88a9f8d22f, baseca2242730380788d49e36a35a8974420df5cbdb0. pnpm typecheck/lint/build pass;8focused suites179pass0fail0skip (.scratch/package-correction-green.log). REDa562f5f tests2fail behavioral failedvsupdated, GREEN36aa236 fixes progress. EarlierRED/GREENchains preserved in briefs. Broad local symlinkEPERM and journeyframe-timeouts unresolved as complete-suite evidence; no full-local-green claim. Remote CI result pending at PR creation.

## Independent review
R4ed6ccab7-2e93-431e-9444-7f00b4baebda native terminal completion/report consumed, StandardsPASS/SpecPASS/aggregatePASS on exact36aa236, R3-01resolved. Exactpatch37765bytes SHA2562ab23b1136bc71626533ec75f80406d150a66b9f7c79742ff3eb794e56576b84. Read-only static review, coordinator test results supplied/not personally rerun. Preserves R1/R2inconclusive and R3Specfail on earliercandidate; no relabel. Raw returned artifact outputs/ed6ccab7-2e93-431e-9444-7f00b4baebda/.isswf/initiatives/I0017/jobs/J002/review-r4.md retained by native host.

## Scope
15files256additions25deletions, below400. Private .isswf/.pi/.scratch and unrelated package-lock.json not staged/pushed. Feature branch fix/package-host-update-evidence ->origin/main. PR75OPEN notdraft https://github.com/iseoane/agent-depot/pull/75, exacthead36aa236 readback verified. Source base remains remote mainca22427 at publication. Default original feature-to-PR start covers publication, no integration/release.

## Integration risk and recovery
Medium: shared update classifier/completion affects both hosts and could misreport eligibility/progress. Boundaries preserved, injected persistence/output tests and independent review mitigate; real Host CLI/version/stateformat differences and fullcrossplatformCI remain residual. Revert feature for code recovery; does not undo any later explicit user Host operation, no live rollback exercised.

## Closure and acceptance
Implementation/localtargetedverification/independentreview/PRpublication complete. FullCIverification and explicit human integration decision still separate/pending. No merge/release/deployment or real user Package update selected. No active writer/reviewer. Correctioncycle1 and4reviewcalls consumed under recorded operator grants; no additional actor/correction autorenewal.

## Blockers and next action
Observe required CI Linux/Windows/pack on exactPRhead; no continuous polling/watch or waitingmodelcalls. If nativeCI notification unavailable, leave pending/manualrevisit. If CI reveals a material new source defect, retain failures and seek scoped budget reconciliation rather than silently exceed exhausted correction/review budget. Integration requires human decision once exactcandidate gates pass.

## Remote write reconciliation
Firstpush returned server500without branch success. Read-only lsremote and PRlist confirmed absent, no uncertain write preserved; one samehead retry succeeded. PR creation then readback verified repository/base/head/body/state. No forcepush, directmainpush or cleanup.
