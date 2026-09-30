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
- [x] A4 Updates: collapsed "cannot be checked" row names the "newer Agent Depot" reason.
  - Evidence: RED (tui-updates-view test) -> GREEN. Row reads `N cannot be checked ▸ (1 installed by a newer Agent Depot)`; also counts A2's `pinned to another Agent Depot`. Route: inline.
- [x] A5 unmanaged symlink identity includes birthtime (`src/user-global-skill-inventory.ts:681`).
  - Evidence: RED (2 fake-lstat tests: equal dev:ino, different birthtime / size) -> GREEN. Symlink identity is `dev:ino:size:birthtime`; directories unchanged. Route: inline.
- [x] A6 README relative links (CONTEXT.md, docs/adr) → absolute GitHub URLs.
  - Evidence: README line 418 links now absolute (`blob/main/CONTEXT.md`, `tree/main/docs/adr` for the directory); no other relative links. Route: inline.
### B — Hardening and packaging
- [x] B1 tarball: drop `.js.map` (or ship src) and skill `test_*.py` / `testdata`; pack-smoke asserts it.
  - Evidence: RED (pack-smoke "dev-only files in tarball": 43 `.map` from the coverage build + 10 skill test/testdata files) -> GREEN with `files` negations (`!dist/src/**/*.map`, `!skills/**/test_*.py`, `!skills/**/testdata`). Clean `pnpm build` emits no maps (only `test:coverage` does), so negations protect a dirty dist; build left unchanged. Tarball 595.5 kB / 2.2 MB / 80 files -> 564.3 kB / 2.0 MB / 70 files. Nothing in src/scripts/skills imports `test_*.py` or `testdata` (only skill READMEs mention running the tests). Route: inline.
- [x] B2 bulk actions: strict drift detection between items (only the expected change from the previous item is absorbed).
  - Evidence: RED (2 new tests: intruder record added after item 1 was absorbed, items 2-3 applied) -> GREEN. Baseline now advances only by the item's own change (removed selections / `plan.updated`), and `assertNoDrift` runs before every item, failing it with "The installation records changed outside this batch ... left untouched". Normal multi-item bulks covered by the existing tests. Route: inline.
- [x] B3 `src/tui/keys.ts` ESCAPE_REMNANT only matches real CSI/SS3 final bytes.
  - Evidence: RED (`Ok`/`OK`/`Oa`/`[a`/`Oz` not split) -> GREEN. Regex `^(?:\[[\d;<:?]*[A-DFHIMOPQRSZm~]|O[A-DFHPQRS])$`; real remnants still whole; pasting `Ok`/`OK` into the Source URL input and the catalog filter keeps the text. Route: inline.
### C — Maintainability
- [x] C1 remove duplicated blocks (18 groups) in `project-installation.ts` and the TUI views.
  - Evidence: `fallow dupes` 18 clone groups / 400 lines -> 3 groups / 37 lines. project-installation: `rollbackAndRethrow`, `recordCreatedClaudeSymlink`, `safeChildPath`, `prepareReplacementPaths`, `installedTreeSummary`, `writeRegularFile`. TUI: `mode-keys.ts` (checklist, yes/no, version input), `panel-parts.tsx` (checklist, preview, footer), `view-state.ts`, `tree-navigation.ts`. Kept on purpose: `skill-discovery.ts` 373/447 (two different directory walkers sharing only a readdir+sort prologue), `cli.ts` 474/520 (two selection resolvers with different lookup rules), `adoption-actions.ts`/`catalog-flow.ts` (same call shape with different mode transitions). `installedTreeSummary` reorders keys of the update/overwrite result objects; they are never serialized directly. Route: delegated writer.
- [x] C2 reduce complexity: `CatalogView`, `UpdatesView`, `handleManageKey`, split `installations-view.tsx`.
  - Evidence: cognitive CatalogView 52 -> 25 (inner arrow 46 -> gone), UpdatesView 39 -> 25 (arrow 55 -> gone), handleManageKey 40 -> 4, InstallationsView arrow 61 / handleModeKey 53 -> gone (view 20). installations-view.tsx 542 -> 152 lines (tree, browse, adoption, panel, rows modules); catalog-view.tsx 493 -> ~110. Health score (with coverage) 92 -> 93. Existing tests unchanged (519 pass).
- [x] C3 tests for the complex untested functions in `src/path-safety.ts`.
  - Evidence: 4 characterization tests added (traversal normalization, relative paths, symlinked leaf/dangling/ancestor chain, root, ENOTDIR); they passed immediately. Commit 8de0ecd.
### D — Release
- [x] D1 version 0.2.1, CHANGELOG entry (tag and GitHub release after merge, still pending).
  - Evidence: `package.json` 0.2.1; CHANGELOG `## [0.2.1] - 2026-09-30` covers groups A, B, C and the two review minors (nothing-to-install exit 1 with a summary line on partial skips; Updates scope keys in a Map). Version test and TUI header read `package.json`, so they follow automatically. Route: inline.

## Progress

Summary: groups A, B, C and D1 are done on `release/0.2.1`; the two minors from the independent review are fixed. Remaining after merge: tag `v0.2.1` and the GitHub release.

