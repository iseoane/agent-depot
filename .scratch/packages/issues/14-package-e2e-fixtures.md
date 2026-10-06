# 14: Package end-to-end fixtures and the import-graph assertion

**What to build:** The end-to-end proof over real fixtures, plus the structural
assertion that the canonical Skill constraint holds.

- A pstack-shaped fixture repository used across units, with both the Pi package
  form and the Claude plugin and marketplace form over one shared skills
  directory.
- Isolated fixture host state homes holding the observed `settings.json` and
  `installed_plugins.json` shapes.
- An end-to-end test that discovers both bundles, previews and installs each
  through a fake runner, checks versions, updates, and uninstalls.
- An import-graph assertion that no `package-*` module reaches
  `project-installation.ts` or the Skill install engine.
- A read-only home run proving only `packages.json` and `package-approvals/`
  change.

**Blocked by:** 10, 11, 12, 13.

**Status:** completed

- [x] One repository yields a Pi descriptor and a Claude descriptor over the same skills directory.
- [x] The full lifecycle for both hosts runs against the fake runner with asserted argv.
- [x] Installed evidence is read from the fixture host homes, and `unknown` appears for the unversioned case.
- [x] The import-graph assertion fails when a `package-*` module imports the Skill install engine.
- [x] No file under a fixture Host skill root is created, changed, or removed.

## Verification

- `tests/e2e-packages.test.ts` and `tests/package-boundaries.test.ts`.
- `pnpm test`, `pnpm typecheck`, and `git diff --check` pass.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/e2e-packages.test.ts and tests/package-boundaries.test.ts.
