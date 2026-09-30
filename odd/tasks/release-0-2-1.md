# Release 0.2.1

## Objective
Ship every finding of the 0.2.1 review (2026-09-30) as a patch release of @iseoane/agent-depot. User decision: include all items, including the ones classified as "later".

## Constraints
- Patch semver only: no CLI surface change beyond `--help` output.
- Strict TDD (RED first) for behavior changes; refactors keep all tests green with no behavior change.
- Publishing (`npm publish`) is done by the user from a real terminal (passkey).
- Branch `release/0.2.1` → one PR per group below.

## Tasks
### A — Fixes
- [x] A1 audit green: `tests/version.test.ts:10` path form not read as an import; `.fallowrc.json` ignore `skills/doctor-md-skill/assets/pierre-diffs.js`; boundary zones for the 31 uncovered files.
  - Evidence: `pnpm audit:all` failed (1 unresolved import, 31 uncovered files) -> exit 0. New zone `tui` (src/tui/**, allows application/core/infrastructure), `tooling` (scripts/**, allows nothing); cli may use tui; skill-hosts/skill-install/skill-removal/unmanaged-removal/update-flow joined `application`, usage-error joined `infrastructure`. No real violation surfaced. Route: inline.
- [x] A2 fixed-policy built-in with a different version must not invalidate the whole project manifest (`src/project-manifest.ts:345`); per-skill "newer Agent Depot / not reproducible" state.
  - Evidence: RED (3 tests failed: manifest parse, update-batch reason, `install --manifest` skip) -> GREEN (`pnpm test` 499 pass). Parser accepts the mismatch; `builtinPinMismatch()` drives update check (unknown, "Pinned to Agent Depot X; running Y") and manifest install (skipped with reason, others install). `install --version fixed:<other>` for a new install is still rejected in `selectInstallSource`. Route: inline.
- [x] A3 `--help` / `-h` / `help` print usage to stdout and exit 0.
  - Evidence: RED (3 help tests failed) -> GREEN. Only the bare explicit forms print help; no args and `--help extra` stay exit 1 usage errors; USAGE text unchanged. README updated. Route: inline.
- [ ] A4 Updates: collapsed "cannot be checked" row names the "newer Agent Depot" reason.
- [ ] A5 unmanaged symlink identity includes birthtime (`src/user-global-skill-inventory.ts:681`).
- [ ] A6 README relative links (CONTEXT.md, docs/adr) → absolute GitHub URLs.
### B — Hardening and packaging
- [ ] B1 tarball: drop `.js.map` (or ship src) and skill `test_*.py` / `testdata`; pack-smoke asserts it.
- [ ] B2 bulk actions: strict drift detection between items (only the expected change from the previous item is absorbed).
- [ ] B3 `src/tui/keys.ts` ESCAPE_REMNANT only matches real CSI/SS3 final bytes.
### C — Maintainability
- [ ] C1 remove duplicated blocks (18 groups) in `project-installation.ts` and the TUI views.
- [ ] C2 reduce complexity: `CatalogView`, `UpdatesView`, `handleManageKey`, split `installations-view.tsx`.
- [ ] C3 tests for the complex untested functions in `src/path-safety.ts`.
### D — Release
- [ ] D1 version 0.2.1, CHANGELOG entry, tag after merge, GitHub release.

## Progress
