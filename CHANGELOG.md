# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-09-30

### Fixed

- A project manifest that pins a built-in Skill to another Agent Depot version stays loadable; `install --manifest` skips that Skill with its reason and installs the rest.
- `install --manifest` now fails with exit code 1 ("Nothing to install") when every Skill is skipped, and prints a summary line when only some are.
- `--help`, `-h` and `help` print the usage and exit 0.
- The Updates view names the reason on the collapsed "cannot be checked" row.
- Unmanaged symlink identity includes birth time and size, so a replaced symlink is no longer mistaken for the original.
- Bulk actions in the TUI detect drift strictly: a change to the installation records outside the batch stops the affected item and leaves it untouched.
- The TUI only treats real terminal escape sequences as escape remnants, so pasting text such as `Ok` into an input keeps it.
- Updates scope keys (`t`, `p`, `g`) are looked up in a Map, so prototype property names can never match.

### Changed

- The npm tarball is smaller: source maps and Skill tests are excluded.
- README links are absolute GitHub URLs so they work on npm.

### Internal

- Every source file is covered by a dependency-boundary zone (fallow audit); the version test path was fixed.
- Duplicated blocks removed (18 clone groups down to 3) in project installation and the TUI views.
- Cognitive complexity reduced in the catalog, updates and installations views and their key handlers; `installations-view.tsx` and `catalog-view.tsx` split into focused modules.
- Characterization tests for the complex functions in `src/path-safety.ts`.

## [0.2.0] - 2026-09-30

### BREAKING

- Node.js >= 24 (Active LTS) is now required. See `docs/adr/0002-node-24-lts-minimum.md`.
- The package is now published as `@iseoane/agent-depot` (the `agent-depot` command is unchanged).

### Added

- `agent-depot tui`: interactive terminal UI with Sources, Catalog, Installations and Updates views (requires an interactive terminal).
- `agent-depot skill remove <id|path>... [--host <host>...]`: remove managed user-global Skills, or only selected hosts.
- `agent-depot skill host add <id|path> --host <host>...`: add hosts to an installed Skill.
- `agent-depot uninstall --unmanaged-skill <exact-global-path>...`: remove unmanaged user-global Skills.
- `agent-depot --version` (and `-v`); the TUI header shows the version.
- MIT license and npm package metadata; CI runs typecheck, lint, unit tests, a TUI end-to-end test in a real pseudo-terminal, and a pack smoke test.

### Changed

- `package.json` is the single source of the package version; `src/version.ts` was removed.

## [0.1.0]

- Initial private release: Git Source catalog, discovery, project and user-global installation, updates and uninstall.
