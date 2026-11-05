## Why the change

Prepare patch release **0.6.7** for two Windows installation blockers: stale managed Skill records could neither be removed nor reinstalled, and Claude directory symlink creation required privileges unavailable to ordinary Windows users.

## Change outline

- Explicitly confirmed missing-installation recovery removes only the verified stale record, with no file deletion. Shared CLI/TUI flows check paths, host locations, record snapshots and batch classification again before mutation.
- Claude exposure uses an absolute-target directory junction on Windows; POSIX keeps relative directory symlinks. Fresh install, added exposure and overwrite share creation policy. Rollback unlinks recorded aliases without following their targets.
- Add native Windows junction lifecycle/ancestor/overwrite rollback coverage and isolated recovery tests; update domain/ADR/docs, version and changelog.

## Special things to note

- Maintainer explicitly approved **size:exception** for this single, already independently reviewed release candidate (956 changed lines after two test-expectation corrections), and a release-scoped exception for the unavailable supporting `code-review` procedure. Existing substantive independent reviews remain applicable; no CI or publishing check is waived.
- Independent review found and then verified closure of batch ordering, stale Source-removal record snapshots, cross-surface messaging and native junction verification gaps. Final behavior verdicts: **Spec pass**. Formal Standards verdict remained inconclusive solely for the supporting procedure above.
- No dependency changes, directory-copy fallback, Windows privilege changes or installed CLI replacement. Unrelated local configuration, lockfiles and raw/private investigation artifacts are excluded.

## Risk assessment

**Medium.** This affects shared managed-installation ownership and Windows filesystem aliases. A stale preview or wrong-target alias could lose tracking or expose/delete unintended content. Snapshot comparisons, canonical/Claude path checks, whole-batch classification guards, identity checks and isolated no-outside-write/rollback regressions mitigate these risks. There is no atomic cross-filesystem/state transaction guarantee.

Detection is through explicit previews, fail-closed errors, lifecycle tests and CI. Reverting this patch restores prior behavior but does not automatically recreate forgotten installation records. Native rollback tests restore overwritten content and remove created aliases. Existing full-removal behavior is not represented as a newly audited exclusive-unlink guarantee. Residual limits: local full-suite failures were not proven baseline-only; legacy symlink fixtures skipped on the unprivileged host, and discovery by a real Claude process was not exercised. Exact-head CI and the normal publish workflow remain mandatory.

## Testing

- Worker on final junction candidate: affected installation/host/update/inventory/lifecycle suites **100 total: 87 passed, 13 existing capability skips, 0 failed**, including real Windows junction creation, repeated recognition, alias-only removal, ancestor rejection and overwrite rollback.
- Recovery focused checks: core 8/8, CLI 10/10, TUI 3/3; subsequent Source-removal/checklist delta 4/4 (results from their respective reviewed candidates).
- Coordinator on release metadata: `pnpm typecheck`, `pnpm lint`, `pnpm build`, release-artifact/release-notes tests **9/9**, isolated version tests **8/8**, and `git diff --check` passed. Release fixtures used native Windows tar through a command-local PATH after Git tar misinterpreted drive-letter paths.
- Actual controlled installation of all three builtin Skills for Claude succeeded without elevation; each alias had an absolute canonical target and readable `SKILL.md` through it. No claim of Claude in-process discovery.
- Exact-head CI **passed** on `1b39b8173c10233c6f885cdb6bc579d532784afe`, run https://github.com/iseoane/agent-depot/actions/runs/41775609222: Linux full tests/E2E/release tests, Windows full tests, and packaging. The audit job is intentionally skipped for pull requests by existing workflow policy; release verification still runs its required audit.
- Two earlier CI failures identified stale test expectations (new progress label and Windows absolute link target); both were corrected without production changes. Local affected progress tests17/17 and host-add test1/1 passed before exact-head full CI.
- Full release workflow verification/publish/integrity/tag/release: **pending**.
