# 05: package-host-plans.ts argv templates, blast radius, approval digest, update classification

**What to build:** The single owner of each host CLI grammar, per section 4.2 of
`.scratch/packages/design.md`. Pure. No I/O.

- `HOST_STEP_TEMPLATES` for Pi and Claude, covering install, update, uninstall,
  select, and forget. Pi update is `pi update --extensions`, which is host-wide.
  Claude install is two ordered steps, `marketplace add` then `plugin install`,
  with the `add` step omitted when the host already knows the marketplace.
- `planHostSteps`, which throws when a Claude descriptor has no marketplace
  binding.
- `affectedBy`, which returns the selection coordinates for install, uninstall,
  select, and forget, and every recorded Pi coordinate for update.
- `packageApprovalDigest` over the canonical serialization of `PackageDeclaration`.
- `classifyUpdate` over installed evidence and available evidence. Both manifest
  versions compare through `sameAppVersion` and `compareAppVersions`, both commits
  compare by equality, and a mixed or missing pair is `unknown`.
- Every produced argv is re-validated through `parsePortableInstallationMethod`.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] First, verify every non-obvious verb against the installed host CLI: `pi update --extensions`, the Claude plugin update and uninstall tokens, and `claude plugin marketplace add` idempotency. Mark any verb with no primary source as `manual required` rather than guessing, and record the finding on this ticket.
- [ ] Exact argv vectors are asserted per host, action, and pin.
- [ ] A known marketplace omits only the `add` step and still runs `install`.
- [ ] `affectedBy` returns every recorded Pi coordinate for an update.
- [ ] `classifyUpdate` returns `unknown` for a mixed manifest-version and git-commit pair.
- [ ] A control character, a shell metacharacter, or a `.cmd` executable in a generated argv is rejected.

## Verification

- `tests/package-host-plans.test.ts`, pure, asserting the argv strings themselves as the contract.
