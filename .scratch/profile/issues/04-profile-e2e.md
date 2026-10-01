# 04: End-to-end tests for profile export and import

**What to build:** Hermetic end-to-end coverage at the level of the existing suites: export from one sandbox HOME and import into another with the built CLI (Sources, Skills on several Hosts, App recipes for two platforms), plus the TUI tab in a real terminal.

**Blocked by:** 01, 02, 03.

**Status:** completed

- [x] A CLI round-trip reproduces Sources, user-global Skills with their Hosts, and recipes (unapproved) in a fresh destination.
- [x] Importing again reports everything as "same" and writes nothing.
- [x] The TUI exports and imports a profile through the new tab.

## Implementation evidence

- Built CLI round-trip: isolated HOME/XDG directories, portable HTTPS Git Source
  rewritten to a local repository with Git transport restricted to `file`, built-in
  and external Skills on Claude/Pi, same-name Linux/Windows App recipes. Preview
  leaves every file unchanged; repeated confirmed import reports five `same`
  choices and preserves all destination file contents and mtimes.
- Real PTY: exports through tab 5, imports through tab 5 into a fresh HOME, checks
  both confirmation boundaries and compares the destination export.
- Bug found: identical App recipes were classified as conflicts on re-import.
  Minimal shared-core fix treats one valid identical platform/content match as
  `same`; invalid, duplicate, changed and overlapping-platform recipes still conflict.
  Existing TUI conflict coverage now uses genuinely different recipe content.
- `app list` lists applicable recipes only: the Linux recipe shows `needs approval`;
  the Windows recipe is verified present through destination export rather than
  expecting a nonapplicable row from that command. No App installation or approval
  receipts are created by import.
- Verification: `pnpm typecheck`, `pnpm lint`, focused CLI test (1 passed), focused
  import tests (18 passed), `pnpm test` (721 passed), `pnpm test:e2e` (4 passed).
- Review: Standards and Spec checked against the initial HEAD (`134e565`) and the
  Profile spec; no remaining findings. Parallel sub-agent review was unavailable
  in this harness, so both axes were reviewed directly.
- Rollback: remove Profile E2E fixture/CLI test and new PTY case independently;
  revert recipe classifier and adjusted import/TUI assertions together for the bug fix.
