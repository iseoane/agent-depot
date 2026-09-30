# Feature: Publish Agent Depot as an npm package

## Status
In progress — TUI work finished; P1-P5, P7 done on branch chore/ci-e2e-package, P6 (publish) pending user confirmation.

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
- [x] P1 — package.json: rename to `@iseoane/agent-depot`, remove `private`, add `files` (`dist/src`, `skills`, `README.md`, `LICENSE`), `license: MIT`, `repository`, `author`, `keywords`, `publishConfig.access: public`, `prepublishOnly` (build + test); check that `readAgentDepotPackageVersion` and any code reading the package name still work after the rename.
  - Done: `name` `@iseoane/agent-depot`, `private` removed, `files`, `license`, `author`, `repository`/`homepage`/`bugs`, `keywords`, `publishConfig.access`, `prepublishOnly` (build + test); `bin` still `agent-depot`. `readAgentDepotPackageVersion` and the built-in skills root (`findPackageRoot`) are name-independent; verified by the installed-tarball smoke test.
- [x] P2 — Add MIT `LICENSE` file (author iseoane).
  - Done: `LICENSE` (MIT, 2026 iseoane).
- [x] P3 — Version `0.2.0` and CHANGELOG (new `tui`, `skill remove`, `skill host add`; breaking: Node >= 24).
  - Done: version 0.2.0; `CHANGELOG.md` (Keep a Changelog) with BREAKING Node >= 24 and the new commands.
- [x] P4 — `npm pack` dry run: inspect the tarball contents, install the `.tgz` in a clean temp directory, and verify `agent-depot --help`, `agent-depot tui` (manual), built-in skill discovery and the Ink load from dependencies.
  - Done: `scripts/pack-smoke.mjs` (`pnpm test:pack`, CI job `pack`): 78 files in the tarball (42 under dist/src, skills, package.json, README.md, LICENSE, CHANGELOG.md); asserts no tests/coverage/odd/.scratch; clean `npm install ./x.tgz`, `--version`, `--help`, `discover builtin:agent-depot` and a TUI module import against a temp HOME all pass.
- [x] P5 — README: install/run instructions for npx / pnpm dlx / global install.
  - Done: README "Install" section (npx, pnpm dlx, global).
- [x] P7 — Single version source: `package.json` only; remove `src/version.ts` (only used by tests/version.test.ts) or derive it from `AGENT_DEPOT_PACKAGE_VERSION`; add `agent-depot --version`; show the version in the TUI header (`Agent Depot v0.2.0`).
  - Done: `src/version.ts` removed; `AGENT_DEPOT_PACKAGE_VERSION` (from package.json) is the only source; `--version`/`-v` in `runCli`; TUI header `Agent Depot v<version>`. RED: 3 failing tests (header, `--version`, `-v`); GREEN: 474 pass x2.
- [ ] P6 — (User-confirmed step) `npm publish`.
