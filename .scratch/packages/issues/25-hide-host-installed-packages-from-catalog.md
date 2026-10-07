# 25: Hide host-installed Packages from Catalog

**What was wrong:** Catalog showed every discovered Package, including bundles
that the host state proved were already installed. Package ownership classified a
selected bundle before checking host state, so it could not distinguish a
selection from a selected-and-installed bundle.

**Evidence:** The read-only Pi settings record contains the pstack Git source
without a pin. The matching Agent Depot record selects the Pi bundle and has a
delegated commit but no verified host version. This proves the host has the
Package, but it does not prove the installed version. The global npm copy was
not used to identify the running Agent Depot version.

**What changed:** The ownership classifier now records the exact Package
selection and distinguishes selected, installed, and selected-and-installed
bundles. Catalog filters only host-proven installed Packages by the full
selection identity. Selected-only bundles and bundles with unknown host state
remain listed. The Installations view still shows tracked Package records.

**Known limitation:** The observed Pi settings entry has no pin, version, or
commit evidence. Agent Depot can confirm that Pi lists the Package, but it cannot
compare the installed Package with the available manifest version. Updates must
continue to report `cannot assess` rather than guess. This follows ADR 0009.

**Status:** completed

- [x] Host-proven installed Pi and Claude bundles disappear from Catalog after refresh.
- [x] A Package for another Host remains in Catalog.
- [x] Selected-only and host-state-unknown bundles are not treated as installed.
- [x] Installations retains the Package row.
- [x] Updates show a Claude Package when host and available version evidence prove an update.
- [x] Updates do not report an unversioned Pi Git Package as an update.

## Verification

- `tests/tui-package-journey.test.ts` drives both host installs through Catalog,
  Installations, and Updates with the pstack fixture and fake host state.
- `tests/tui-catalog-view.test.tsx` checks exact host and selection filtering.
- `tests/package-ownership.test.ts` checks selected, installed, selected-and-installed,
  and unreadable-host-state classifications.
- `pnpm test` passes all 984 tests. `pnpm typecheck`, `pnpm lint`,
  `pnpm audit:dead-code`, and `pnpm test:e2e` pass.
