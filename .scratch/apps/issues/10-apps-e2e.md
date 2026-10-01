# 10: End-to-end tests for Apps (CLI and TUI)

**What to build:** Hermetic end-to-end coverage for Apps, at the same level as the existing Skill suites (`tests/e2e-lifecycle.test.ts` for the CLI and `tests/e2e/tui.e2e.test.ts` for the TUI), running the built CLI against a real filesystem and real processes.

- CLI: a recipe whose executable is a fake Node script on a temporary PATH, driven through `app validate`, `app approve`, `app list`, `app install`, `update check` / `update apply --app`, `app setup` / `app teardown --host`, a manual-fallback step with `--manual-done`, and `app uninstall`. `latest` uses `argv` so no network is touched.
- TUI: in a real terminal, the Apps group in Installations (approve and install) and an App row in Updates.

**Blocked by:** 01–09.

**Status:** completed

- [x] The CLI suite covers the full App lifecycle above against the built package, hermetically (temporary HOME and PATH, no network).
- [x] An unapproved recipe never runs a command, and a changed recipe requires re-approval.
- [x] The TUI suite approves and installs an App from Installations and shows it in Updates.
- [x] Both suites run under the existing `pnpm test` / `pnpm test:e2e` scripts.

## Verification

- `pnpm typecheck` and `pnpm lint`: passed.
- `pnpm test`: 640 passed; `pnpm test:e2e`: 3 passed.
- Focused CLI suite: 1 passed; real-terminal App scenario: passed.
- Shared fake executable uses temporary PATH, version state and argv/cwd audit log;
  latest is local argv, with no registry or network lookup. App cases skip Windows
  because the executable fixture uses a POSIX shebang, not a shell/.cmd workaround.
- Covers approval invalidation, failed post-install version evidence, persisted
  install/update versions, explicit batch App selection, independent Host failures,
  spawn-failure manual completion and removal of tracking.
- No production bugs found and no production code changed. Tests characterize
  existing behavior; no production red/green cycle was needed.
- Standards/spec review completed locally; parallel review agents are unavailable
  in this harness. No outstanding findings.
- Rollback: remove `tests/e2e-apps.test.ts`, `tests/fake-app-fixture.ts` and the App
  scenario/environment override in `tests/e2e/tui.e2e.test.ts`; Skill coverage is unchanged.
