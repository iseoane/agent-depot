# Feature: Publish Agent Depot as an npm package

## Status
Planned — do NOT start until the TUI work (odd/tasks/tui.md) is finished and reviewed with the user (user decision 2026-09-30).

## Objective
Make Agent Depot installable and runnable with `npx @iseoane/agent-depot`, `pnpm dlx @iseoane/agent-depot` or a global install exposing the `agent-depot` command.

## Decisions (user, 2026-09-30)
- Package name: `@iseoane/agent-depot` (public scoped package; command stays `agent-depot`).
- License: MIT.
- Publishing (`npm publish`) is a separate, explicitly confirmed step.

## Findings
- `bin` already points to `dist/src/cli.js`, which has a `#!/usr/bin/env node` shebang.
- Built-in skills resolve from the package `skills/` directory (commit 8362881).
- `"private": true` blocks publishing; no `files` list (would publish tests, coverage, odd/, .scratch/); no LICENSE file; no repository/author/keywords metadata.

## Tasks
- [ ] P1 — package.json: rename to `@iseoane/agent-depot`, remove `private`, add `files` (`dist/src`, `skills`, `README.md`, `LICENSE`), `license: MIT`, `repository`, `author`, `keywords`, `publishConfig.access: public`, `prepublishOnly` (build + test); check that `readAgentDepotPackageVersion` and any code reading the package name still work after the rename.
- [ ] P2 — Add MIT `LICENSE` file (author iseoane).
- [ ] P3 — Version `0.2.0` and CHANGELOG (new `tui`, `skill remove`, `skill host add`; breaking: Node >= 24).
- [ ] P4 — `npm pack` dry run: inspect the tarball contents, install the `.tgz` in a clean temp directory, and verify `agent-depot --help`, `agent-depot tui` (manual), built-in skill discovery and the Ink load from dependencies.
- [ ] P5 — README: install/run instructions for npx / pnpm dlx / global install.
- [ ] P7 — Single version source: `package.json` only; remove `src/version.ts` (only used by tests/version.test.ts) or derive it from `AGENT_DEPOT_PACKAGE_VERSION`; add `agent-depot --version`; show the version in the TUI header (`Agent Depot v0.2.0`).
- [ ] P6 — (User-confirmed step) `npm publish`.
