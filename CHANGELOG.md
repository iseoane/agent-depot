# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
