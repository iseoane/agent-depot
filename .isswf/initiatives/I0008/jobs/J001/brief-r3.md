# Job brief I0008/J001 r3 (correction after V001)
Same authorization as r2. Read V001.md here.
Skills and evidence: follow isswf-tdd for M2 — write the negative test first, show it passing on base logic and that it would fail if the comparison were removed (paste output). 
1. M1: `isolateUserState` (tests/state-home.ts) pins and restores XDG_STATE_HOME on POSIX (and Windows vars as now) so the helper is self-contained; extend tests/source-state-isolation.test.ts to cover a test using it if cheap.
2. M2: test that a Pi checkout path which is a subdirectory of a parent Git repo is refused ("not the root of its Git checkout"), running on Linux and Windows.
3. L3 (if cheap): narrow the tui-file-picker skip to the chmod part only (mid-test t.skip), and run a case-insensitive-safe subset of the wildcard-ownership test on win32.
4. Linux checks + Windows CI green; record run ID. Commits test/fix, no attribution. Report A003.md.
