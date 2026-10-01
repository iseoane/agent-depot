# 06: TUI: "Apps (user-global)" group in Installations

**What to build:** Add an Apps root group to the Installations tree, with no new tab or screen.
- Rows show the installed version, "not installed", "invalid recipe: <reason>", or "needs approval".
- Keys: Enter approves, `i` installs, `u` uninstalls, `h` opens the Host checklist for setup and teardown, and space/`a` mark Apps for bulk actions.

**Blocked by:** 03, 04.

**Status:** ready-for-agent

- [ ] Approval, install, uninstall, and setup reuse the existing preview panel and y/n confirmation.
- [ ] A manual step shows the command; `y` means "done, check now" and runs `version`.
- [ ] `version` checks are lazy or cached, so TUI start-up stays fast.
- [ ] Sources and Catalog are unchanged.
