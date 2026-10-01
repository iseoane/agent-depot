# 03: Install and uninstall Apps via CLI, with manual steps

**What to build:** `agent-depot app install|uninstall <name> [--yes]` runs the recipe step after a preview and confirmation. Each step falls back to a guided manual step when Agent Depot cannot launch it. The installed state is recorded only when `version` confirms it.

**Blocked by:** 02.

**Status:** completed

- [x] The preview shows the argv or manual text, the resolved executable path, and the environment.
- [x] Manual fallback happens only when the process cannot be spawned. A non-zero exit is reported as a failure with its output.
- [x] After a manual step, the user confirms that it is done, and Agent Depot then runs `version`.
- [x] After install, the App is recorded as installed only if `version` succeeds. After uninstall, the App is untracked only if `version` fails, or if the user explicitly forgets it.
- [x] Steps run with the user's home directory as their working directory.


## Implementation evidence

- Core work unit: `cb4269a` (shared lifecycle plans, verified atomic records, manual completion).
- CLI work unit: preview/rerun install and uninstall, explicit `--manual-done` and `--forget`; see spec lifecycle decisions.
- Focused tests: `pnpm test:single tests/app-lifecycle.test.ts` (7 passed), `tests/app-cli.test.ts` (6 passed), `tests/app-flow.test.ts` (12 passed).
- Runtime boundary: CLI seam tests invoke `runCli` with real temporary recipe/state directories and injected executable resolver/runner; no external App is installed.
- Rollback boundaries: core unit removes lifecycle operations/records without changing Source/Skill state; CLI unit removes lifecycle routing/help/docs without removing recipe approval/listing.
- Final verification: `pnpm typecheck` passed; `pnpm lint` passed; `pnpm test` passed all 551 tests (0 failures/skips). CLI help regression suite: 70 passed. The first full run exposed the outdated exact-help expectation; it was updated and all checks rerun successfully.
