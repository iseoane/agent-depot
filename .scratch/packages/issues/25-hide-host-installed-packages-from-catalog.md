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

**Pi Git checkout evidence:** A Pi settings entry proves Package membership, not
its installed version. Agent Depot now resolves the checkout with Pi 1.0.3's Git
install path, then checks the checkout root, `origin`, clean state, `HEAD`, and
`package.json` at that commit. A dirty, missing, or mismatched checkout remains
installed and hidden from Catalog, but Installations reports that version
comparison is unavailable. Updates say `cannot assess`. The inspection preserves
local checkout changes and never uses `lastDelegatedCommit` as installed evidence.

**Status:** completed

- [x] Host-proven installed Pi and Claude bundles disappear from Catalog after refresh.
- [x] A Package for another Host remains in Catalog.
- [x] Selected-only and host-state-unknown bundles are not treated as installed.
- [x] Installations retains the Package row.
- [x] Updates show a Claude Package when host and available version evidence prove an update.
- [x] Updates do not report an unversioned Pi Git Package as an update.
- [x] A dirty Pi checkout remains host-installed and hidden from Catalog while
  version and update evidence stay unavailable.
- [x] Installed Pi versions come from the actual clean checkout `HEAD`; the
  settings pin and Agent Depot's delegated commit do not stand in for it.

## Verification

- `tests/tui-package-journey.test.ts` drives both host installs through Catalog,
  Installations, and Updates with the pstack fixture and fake host state.
- `tests/tui-catalog-view.test.tsx` checks exact host and selection filtering.
- `tests/package-ownership.test.ts` checks selected, installed, selected-and-installed,
  and unreadable-host-state classifications.
- `pnpm test` passed all 984 tests at the original closure. The Pi checkout
  follow-up is verified by the targeted tests listed above; full gates are rerun
  for this follow-up.

## Comments

- 2026-10-07: Pi settings membership and checkout version evidence are separate.
  A local checkout change does not turn an installed Package into an unknown or
  absent installation. It blocks version comparison and leaves the checkout untouched.
