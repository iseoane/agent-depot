# 12: TUI Package rows and actions

**What to build:** Package surfaces in the existing views, with no new tab, per
section 5 of `.scratch/packages/design.md`.

- `src/tui/package-actions.tsx` mirroring `app-actions.tsx` for preview, approve,
  and confirm modes.
- Catalog lists bundles per Source as a collapsed group, with bundle-owned skill
  rows dimmed through the matcher.
- Installations gains a Package row group showing name, host, installed evidence
  or `unknown`, available version, and any drift.
- Updates shows Package rows in the shared batch.
- Package rows reuse the existing keys and the existing preview panel and
  confirmation.
- Extend `TuiPackagesEnvironment` on the environment seam for tests.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] Catalog shows both bundles of the dual-format fixture Source, and dims the shared skill rows.
- [ ] Installations shows a Package row with `unknown` for an unversioned Pi git package.
- [ ] Install, update, uninstall, approve, and forget reach the preview and confirm flow via existing keys.
- [ ] `n` or `Esc` cancels at every confirmation without running anything.
- [ ] Listing and reload never run a host version command.

## Verification

- `tests/tui-packages.test.tsx` and extensions to `tests/tui-catalog-view.test.tsx` and `tests/tui-updates-view.test.tsx`, with a fake `PackageOperations`.
