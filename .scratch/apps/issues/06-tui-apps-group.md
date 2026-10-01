# 06: TUI: "Apps (user-global)" group in Installations

**What to build:** Add an Apps root group to the Installations tree, with no new tab or screen.
- Rows show the installed version, "not installed", "invalid recipe: <reason>", or "needs approval".
- Keys: Enter approves, `i` installs, `u` uninstalls, `h` opens the Host checklist for setup and teardown, and space/`a` mark Apps for bulk actions.

**Blocked by:** 03, 04.

**Status:** implemented

- [x] Approval, install, uninstall, and setup reuse the existing preview panel and y/n confirmation.
- [x] A manual step shows the command; `y` means "done, check now" and runs `version`.
- [x] `version` checks are lazy or cached, so TUI start-up stays fast.
- [x] Sources and Catalog are unchanged.


## Implementation evidence

- Shared App core operations drive the existing Installations tree, preview panel,
  HostChecklist, marks and batch runner; no Sources/Catalog changes.
- UX decisions are recorded under “Ticket 06 TUI decisions” in the spec.
- Verification: `pnpm typecheck` and `pnpm lint` passed; focused
  `node --test dist/tests/tui-apps.test.js` passed 9/9; `pnpm test` passed 593/593.
- Runtime harness: the focused Ink tests exercise approval/cancellation,
  install/uninstall, Host setup/manual teardown, approval drift, lazy checks,
  bulk continuation, spawn fallback and non-zero failure in temporary homes.
- Review boundary: `15902187e7299159c83cfacf9cb1a977f3d2c145`.
  Standards and Spec were reviewed directly because this harness exposes no
  sub-agent facility. No unresolved findings; stale lazy-check results were
  guarded against reload generations during review.
- Rollback boundary: revert this ticket's App TUI wiring, cached-inspection
  option, tests and spec decisions together; existing Skill flows remain intact.
