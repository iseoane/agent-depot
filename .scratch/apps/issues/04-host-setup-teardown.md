# 04: Per-Host setup and teardown for Apps via CLI

**What to build:** `agent-depot app setup|teardown <name> --host <host>... [--yes]` runs the recipe's per-Host steps (argv or manual), with a preview and confirmation.

**Blocked by:** 03.

**Status:** completed

- [x] Only Hosts that the recipe declares for the requested step are accepted.
- [x] Manual steps follow the same guided flow as install.
- [x] A failure on one Host does not stop the remaining selected Hosts, and the result is summarised per Host.

## Implementation evidence

- Shared core: `planLifecycle(entry, "setup" | "teardown", host)` reuses lifecycle execution, approval/executable rechecks, home cwd, bounded output and manual fallback.
- TDD: core test initially failed compilation because Host plans were absent; CLI test initially failed with no selected Host commands executed. Both became green after implementation.
- Focused verification: `pnpm test:single tests/app-lifecycle.test.ts` — 13 passed; `pnpm test:single tests/app-cli.test.ts` — 9 passed.
- Runtime harness: the CLI test invokes `runCli` with isolated per-user directories and injected executable resolution/runner. Preview runs no commands; a failing Pi step continues to Codex; manual teardown completion runs only version — passed.
- Final verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` — passed, 562 tests; `git diff --check` — passed.
- Review baseline: `71efec978dc4ff5b40dd502b6bb64f6a192a72dd`. Direct Standards and Spec reviews found no remaining findings; parallel sub-agent review unavailable in this harness.
- Rollback boundary: revert the ticket 04 commit to remove Host lifecycle/CLI support and its tests/docs without altering prior App install/uninstall or Source/Skill runners.
