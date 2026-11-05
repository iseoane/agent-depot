## Why the change

Prepare patch **0.6.9** for the Catalog/Installations performance fix integrated through #76.

## Change outline

Only release metadata changes: package version `0.6.8` → `0.6.9` and a dated CHANGELOG heading that moves the existing performance entry unchanged out of Unreleased. No runtime, dependency, lockfile, test or CI changes.

Base: `e9bac638e0925278f2cf5485cee0e75323c643a0`; head: `affccab863325910cf86241ed6e931ecf8f29fda`.

## Risk assessment

**Low for this metadata delta.** A mismatched version or missing notes could fail publication or mislabel the artifact. Exact two-file diff inspection, CLI version output and release-note/artifact tests mitigate this; the existing publish workflow independently verifies the main commit, package version, artifact identity and registry state before publishing. The underlying medium-risk runtime change retains #76's independent Standards/Spec PASS and green Linux/Windows/pack CI; it is unchanged here.

Publication is externally visible and npm versions cannot be overwritten. Before publication, reverting metadata is possible; after publication, recovery may require another patch. Live rollback is not claimed. Merge remains gated on exact-head CI, then the operator-authorized existing release workflow verifies the final main commit. No user installation update or cleanup is included.

## Testing

- `pnpm typecheck`, `pnpm lint`, `pnpm build`: **pass**.
- Isolated CLI `--version`: **0.6.9**.
- Release artifact and release notes tests: **9/9 pass**, using Windows system tar through process-only PATH to avoid GNU tar's drive-letter interpretation. No test changes.
- Release notes generated successfully; existing entry preserved unchanged.
- Registry preflight: latest `0.6.8`, target `0.6.9` absent at inspection.
- Mechanical delta assessment only for metadata; no new independent runtime review claimed. #76's source review applies to unchanged production code, not to author-run checks.
- Exact-head PR CI: **pending after a failed first Windows attempt** ([run](https://github.com/iseoane/agent-depot/actions/runs/41904240933)). Linux and pack passed; Windows reported 1 failure / 1,197 tests: `approval receipts use canonical file identity and private atomic storage`, with `EPERM` replacing a temporary receipt during concurrent App approvals. The relevant source/test files are unchanged from #76's successful CI. After inspecting the failure, one failed-job-only rerun was requested on the unchanged head; no tests, skips, timeouts or source were modified. The first failure is retained, exact OS cause remains unconfirmed, and publication stays gated on the result. No further automatic reruns if it repeats.
- Prior local full-suite failures remain documented in #76 and are not relabeled green; its remote Linux/Windows/pack CI passed.
