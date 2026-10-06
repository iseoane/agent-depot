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

**Status:** completed

- [x] `update check` lists Package rows with the shared statuses.
- [x] `update apply --all` includes Packages and reports each outcome.
- [x] One failing Package check does not hide the others.
- [x] An `unknown` Package is never offered as an update.
- [x] Project scope never selects a Package.

## Verification

- `tests/package-updates.test.ts` and an extension to `tests/cli.test.ts`, with fake runners and host-state readers.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/package-updates.test.ts and tests/cli.test.ts.
