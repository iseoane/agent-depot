## Why the change

Package updates could offer a newer Git commit for a versioned Claude plugin even though Claude keeps its cached copy until the literal plugin version changes. Pi can legitimately advance commits under the same manifest version, but the previous labels hid that progress.

## Change outline

- Respect each Host's update policy: versioned Claude plugins compare literal cache versions; Pi and unversioned bundles retain conservative commit/ancestry comparison.
- Give the plugin manifest version precedence over marketplace metadata, with entry-version fallback.
- Apply the same Claude policy when verifying lifecycle completion, including a version change with an unchanged commit or a normalized-equivalent version string.
- Use current Host evidence in Updates, label remembered fallback explicitly, and show version plus commit in CLI/TUI comparisons and results.
- Explain differing source commits at an unchanged Claude plugin version without offering an update the Host cannot deliver.
- Record the Host-specific policy in ADR 0009. At the operator's request, project review guidance now selects the isSWF reviewer/procedure without the auxiliary `code-review` prerequisite.

No Host-state writer, automatic reinstall, dependency change, or persisted-schema migration is included. The operator authorized conditional integration and patch publication after verification; package version and changelog prepare **0.6.8**.

## Risk assessment

**Medium.** Shared Package eligibility, completion, and display affect both Pi and Claude users. A policy mismatch could hide a legitimate update, offer an ineffective operation, or incorrectly report progress. Literal Claude cache-version comparison is intentional, not SemVer ordering. Pi's commit-first checks and unchanged/unknown receipt safeguards remain in place.

Mitigations include injected lifecycle tests that assert both the result and persisted evidence, boundary cases for unknown/dirty/unversioned evidence, rendered UI tests, and independent Standards/Spec review. Remaining uncertainty concerns actual Host CLI/state-format variations and complete cross-platform CI. Failures should surface through update status/results and CI. Recovery is a feature revert; it does not undo any Host operation a user separately chooses to run. No live rollback was exercised.

## Testing

Current reviewed head: `62723ef0749a324d6fccf2ab3646fb9e7174d198`; feature base: `ca2242730380788d49e36a35a8974420df5cbdb0`. R4 reviewed unchanged production at `36aa236`; R5 independently approved the subsequent three-file E2E expectation and 0.6.8 metadata delta, Standards PASS and Spec PASS.

- `pnpm typecheck`, `pnpm lint`, `pnpm build`: passed.
- Eight focused Package/CLI/TUI suites with `--import ./dist/tests/isolated-env.js`: **179 passed, 0 failed, 0 skipped**.
- Retained test-only RED checkpoints before their GREEN fixes, including both successful Claude lifecycle cases found during review.
- Independent isSWF static review of this exact head: **Standards PASS, Spec PASS**; the prior lifecycle finding is resolved. Execution results were supplied by the implementer, not rerun by the read-only reviewer.
- Broader local runs were not green: two unchanged tests failed creating privilege-sensitive Windows symlinks (`EPERM`), and Package journey tests hit frame timeouts. Their full origin is not claimed resolved. An earlier CLI output-prefix expectation was corrected and passes in the final focused run.
- Initial CI `41816410415` failed one identical E2E expectation on Linux and Windows: expected `marketplace-entry`, actual `bundle`. R5 confirms manifest-first provenance is correct and that changing the expectation preserves exact version and lifecycle assertions. Local reproduction before: 4 pass/1 fail; after: **5 pass/0 fail**.
- Release artifact/notes checks: initial 6 pass/3 fail with Git GNU tar interpreting `C:` as a remote path; the same unmodified nine tests **all pass** with a process-only PATH selecting existing Windows native tar. No global configuration changes. 0.6.8 release notes generation passes.
- New exact-head Linux/Windows and pack CI are pending. No actual installed Package was updated or reinstalled to test this change.

Suggested review path: Host classification/completion and persistence tests first, then available-version precedence and shared CLI/TUI evidence consumers. The whole feature is below the 400-line review threshold. Required exact-head CI remains a gate. The operator explicitly authorized integration and patch publication after all required checks pass; neither has happened yet.
