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

Verified verbs are recorded in `.scratch/packages/arena/host-cli-verbs.md`. Build against those, not against the guesses in the first draft of the design.

- [x] Every non-obvious verb verified against the installed CLI. `pi update <source>` is scoped, `pi update --extensions` is host-wide, `claude plugin update <plugin>` and `claude plugin uninstall <plugin>` exist, and `claude plugin marketplace update` is scoped only when it is given a name.
- [ ] Use the scoped verb for every V1 action, so `affectedBy` returns the selection's own coordinates. Keep the `plan.affects` mechanism for the host-wide case.
- [ ] `claude plugin marketplace update` is always called with the marketplace name, never unscoped.
- [ ] Exact argv vectors are asserted per host, action, and pin.
- [ ] A known marketplace omits only the `add` step and still runs `install`.
- [ ] `affectedBy` returns every recorded Pi coordinate for an update.
- [ ] `classifyUpdate` returns `unknown` for a mixed manifest-version and git-commit pair.
- [ ] A control character, a shell metacharacter, or a `.cmd` executable in a generated argv is rejected.

## Verification

- `tests/package-host-plans.test.ts`, pure, asserting the argv strings themselves as the contract.
