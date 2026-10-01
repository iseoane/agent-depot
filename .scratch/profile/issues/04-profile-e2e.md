# 04: End-to-end tests for profile export and import

**What to build:** Hermetic end-to-end coverage at the level of the existing suites: export from one sandbox HOME and import into another with the built CLI (Sources, Skills on several Hosts, App recipes for two platforms), plus the TUI tab in a real terminal.

**Blocked by:** 01, 02, 03.

**Status:** ready-for-agent

- [ ] A CLI round-trip reproduces Sources, user-global Skills with their Hosts, and recipes (unapproved) in a fresh destination.
- [ ] Importing again reports everything as "same" and writes nothing.
- [ ] The TUI exports and imports a profile through the new tab.
