# 08: package-flow.ts createPackageOperations

**What to build:** The deep module, per section 4.4 of
`.scratch/packages/design.md`. Nine members plus `checkUpdates` behind one
`PackageOperations` interface, mirroring `createAppOperations` and the ADR 0006
shared-core discipline.

- `discover`, `list`, `inspect`, `approvalStatus`, `approve`, `planLifecycle`,
  `executeLifecycle`, `forget`, `checkUpdates`.
- `planLifecycle` refreshes the Source first, per ADR 0004, so the previewed
  manifest is the one the commands derive from.
- `executeLifecycle` requires confirmation, then `recheckPlan` re-derives and
  diffs `manifestDigest`, `installId`, `resolvedCommit`, and the ordered commands,
  and returns `stale plan` on any difference.
- `skipExecution` records the selection with `lastDelegatedCommit` and runs
  nothing. This is the hand-made App recipe interop.
- A blocked WSL Windows executable falls back to `manual required`.
- `recordOutcome` re-observes every coordinate in `plan.affects` and writes only
  the records whose bundle still resolves. An update additionally requires the
  observed version to differ from the previous one.
- `forget` drops the record and runs no host command.
- `checkUpdates` isolates a per-Package failure.

**Blocked by:** 03, 04, 05, 06, 07.

**Status:** ready-for-agent

- [ ] Install runs the exact host argv once through the injected runner.
- [ ] Mutating the fixture manifest between plan and execute returns `stale plan` and runs nothing.
- [ ] A host state that already satisfies install sets `skipExecution` and runs nothing.
- [ ] An install whose host state stays absent afterwards returns `failed`.
- [ ] An unversioned Pi git package reports `unknown`, never `current`.
- [ ] An update whose observed version is unchanged fails and leaves the record untouched.
- [ ] One broken Package in a batch does not hide the other checks.
- [ ] No `package-installations/` record is written, and no file under a Host skill root is touched.

## Verification

- `tests/package-flow.test.ts` with a fake runner, a fake host-state reader, and an isolated state directory. No real `pi` or `claude` binary.
