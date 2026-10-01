# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-10-01

### Changed

- CI uses `actions/checkout@v7`, `actions/setup-node@v7` and `pnpm/action-setup@v6`, which run on Node.js 24 instead of the deprecated Node.js 20.
- The App and Profile modules are assigned to dependency-boundary zones, so `pnpm audit:dead-code` passes again.
- README: the Usage block lists the `app`, `export` and `import` commands, and Static analysis documents the `tui` and `tooling` zones.

## [0.4.0] - 2026-10-01

### Added

- **Profiles**: a portable, versioned `agent-depot-profile/v1` JSON file to carry a user-global setup to another Agent Depot installation (ADR 0008). It holds Git Sources, user-global Skill selections (Source, path, version policy, Hosts, methods) and App recipe contents, plus the producing `agentDepotVersion`. Local-path and built-in Sources, unmanaged and App-owned Skills, approvals and installed state are never exported; credentials in URLs and absolute paths are rejected, and output is canonically ordered.
- `agent-depot export [--out <file>]` with `--no-sources`, `--no-skills`, `--no-apps` and repeatable `--source`, `--skill`, `--app`; refuses an existing output file and an empty selection.
- `agent-depot import <file> [--yes]`: an add-only plan (add / same / conflict with per-field differences) that never removes or changes anything present. Without `--yes` nothing is written and every Skill's Hosts, version policy and method argv are shown. Imported App recipes arrive unapproved and Apps are never installed; a recipe conflicts only with a same-name recipe whose platform overlaps.
- TUI: a fifth tab **5 Import/Export** with checklists for both directions, previews, y/n confirmation and per-item results.
- TUI: an **App recipes** section in Sources (`Tab` to switch) lists every recipe with its status (approved, needs approval, invalid, not applicable), previews and approves it with Enter, and `n` shows how to add one: install the `agent-depot-apprecipe` skill from the TUI and paste the suggested prompt, or write the recipe by hand in the shown `apps/` directory.

## [0.3.0] - 2026-10-01

### Added

- **Apps**: user-global applications (for example Engram, CodeGraph, GitNexus) managed through user-declared JSON recipes in the per-user `apps/` directory. Agent Depot delegates the lifecycle to the App's own commands, tracks the installed version and never tracks what an App writes, clones App repositories or ships built-in recipes (ADR 0007).
- `agent-depot app schema | validate | approve | list`: recipe JSON Schema, validation per platform (WSL counts as Linux), content-hash approval required before any recipe command runs, and listing with installed version and resolved executable.
- `agent-depot app install | uninstall | update <name>` and `app setup | teardown <name> --host <host>...`: previewed and confirmed steps run without a shell from the home directory; manual steps are shown and confirmed with `--manual-done`; installed state is recorded only when `version` confirms it; `app uninstall --forget` drops tracking explicitly.
- Latest-version lookup from GitHub Releases, the npm registry or an approved argv; Apps join `update check` and `update apply` (`--app <name>`); an update succeeds only when the version changes, and semver downgrades are never offered.
- TUI: an "Apps (user-global)" group in Installations (approve, install, uninstall, Host setup/teardown, bulk marks) and App rows in the Updates batch, with lazy version checks so start-up stays fast.
- Recipe-declared `skills` names/globs exclude App-owned skills from the unmanaged adopt and remove flows.
- Built-in skill `agent-depot-apprecipe` guides an AI agent to research an App and write valid, platform-aware recipes.

### Changed

- `runProcess` accepts an opt-in `maxStderrBytes`; Source and Skill commands keep their previous behaviour.

### Internal

- Hermetic end-to-end coverage for Apps in the CLI and in a real terminal.
- Test processes ignore an exported `XDG_STATE_HOME`, so a developer's own state no longer affects the suite.
- Test processes ignore `FORCE_COLOR`, which `node --test` sets when run from a real terminal; the TUI tests no longer fail under `npm publish` in a TTY.

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
