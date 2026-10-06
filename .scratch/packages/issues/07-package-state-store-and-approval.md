# 07: package-state.ts selections store and approval receipts

**What to build:** The one writer for Package selections and receipts, per
section 5 of `.scratch/packages/design.md`.

- `PackageStateStore` for `<state>/packages.json`, reusing the `SourceStateStore`
  directory-lock, load-validate-mutate-save, and `writeFileAtomically` pattern.
- Keyed by `selectionKey`, so a bundle rename is drift rather than a new identity.
- Approval receipts at `<state>/package-approvals/<digest>.json`, mode `0600`, in a
  `0700` directory, keyed on `packageApprovalDigest`. A changed digest needs
  renewed approval. Approval is rechecked in the plan and re-derived before
  execution.
- A receipt is not portable and never travels in a Profile.

**Blocked by:** 02.

**Status:** completed

- [x] A concurrent update from two processes converges and never corrupts `packages.json`.
- [x] A changed declaration digest invalidates approval, and restoring the bytes restores it.
- [x] Receipt files are mode 0600 inside a 0700 directory.
- [x] Deleting and recreating a receipt at the same digest path with identical bytes restores approval. The store keeps no per-selection file.
- [x] No other module writes `packages.json` or the receipts directory.

## Verification

- `tests/package-state.test.ts` with isolated temporary state directories, mirroring the `source-state` and `app-flow` approval tests.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/package-state.test.ts.
