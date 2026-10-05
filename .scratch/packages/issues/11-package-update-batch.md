# 11: Package checks in the shared update batch

**What to build:** Join Package checks to the existing update batch, following the
App precedent.

- `runUpdate` in `src/cli.ts` includes `checkPackageUpdates` alongside
  `checkAppUpdates` and the Skill batch.
- `agent-depot update check` and `update apply` accept repeatable
  `--package <selection>` and include Packages under `--all`.
- A per-Package failure isolates and does not stop the remaining items.
- The batch renders the shared `unknown`, `current`, and `update available`
  vocabulary.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] `update check` lists Package rows with the shared statuses.
- [ ] `update apply --all` includes Packages and reports each outcome.
- [ ] One failing Package check does not hide the others.
- [ ] An `unknown` Package is never offered as an update.
- [ ] Project scope never selects a Package.

## Verification

- `tests/package-updates.test.ts` and an extension to `tests/cli.test.ts`, with fake runners and host-state readers.
