# I0025: Remove TUI test teardown races on temporary directories

Type: bug

## J001
- Status: completed
- Objective: TUI tests must tear down the rendered App before removing their temporary home/project/state directories, so cleanup never races in-flight state writes (ENOTEMPTY on Linux CI).
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Initiative closed; ships with the next release.

### Acceptance
- In every TUI test file that removes temporary directories and renders the App, directory removal runs after the view is settled and unmounted (node:test runs `t.after` hooks in registration order, so the current order removes directories first).
- One shared, documented test helper (or an equally simple pattern) enforces the order, so new tests cannot reintroduce it; no `rm` retries used to hide the race.
- A deterministic regression shows the ordering: e.g. a helper test proving cleanup runs after registered view teardowns.
- Test-only change; no assertion weakened; full `pnpm test` shows no new failures.

### Evidence
- CI 42292146879 (PR #86, Linux): "an App install in Catalog drops the retained catalog, so the revisit does not show it" failed with ENOTEMPTY rmdir '/tmp/agent-depot-tui-retention-home-*/.local/state'; passed on rerun.
- Coordinator: `node -e` probe shows node:test runs t.after hooks FIFO (A1 then A2). tests/tui-retention.test.tsx:43-55 `directories(t)` registers rm before each test registers its settle+unmount hook (e.g. :388-394).
- Same ordering (rm registered before App render) seen in tui-installations-app, tui-sources-recipes, tui-sources-removal, tui-updates-view, tui-retention; check tui-app, tui-package-journey, tui-profile too.
- Operator 2026-11-06: «2 corrígelo, si todo va bien actualiza readme y release patch». Budget: 1 worker, 1 reviewer, 1 correction cycle.
- Worker (sonnet): RED b3ef6e3 (tests only; helper stub = plain t.after; worker-observed order assertion fails: directories removed before view settle), GREEN 7c87890 (tests/test-cleanup.ts deferCleanup: per-test LIFO stack under one t.after; aggregates failures), 139e62f (18 TUI test files switched every t.after to deferCleanup). Worker full suite Windows: 1265 tests, fail 4 (known TUI frame timeouts by name). tui-app, tui-package-journey already ordered.
- Coordinator at 139e62f: src diff empty; no t.after left in converted files; build/typecheck/lint pass; test-cleanup, tui-retention, tui-sources-removal: 19 pass, 0 fail. Verification: empirical + coordinator inspection (test-only, mechanical, deterministic regression); no semantic review dispatched — proportionate per review.md.
- PR #88 at 139e62f; CI 42305357559: Linux check SUCCESS (test 1259/0, e2e 16/0), pack SUCCESS; Windows first FAILED in tui-profile "a directory read error stays recoverable…" (frame timeout inside the test body at :230, not teardown; one of the 4 known flaky TUI timeouts); one failed-job rerun SUCCESS (1251/0, that test passed). Merged with matching head as 9042eb4; branch deleted. Remaining flaky class: TUI frame timeouts under load (separate from this teardown race).
