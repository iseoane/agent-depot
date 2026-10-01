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

### Review corrections

Applied all feedback from `t03-review.md`: private record directory with permission repair, spawn-code-only fallback, bounded stderr/diagnostics and explicit output-limit errors, warning-and-skip corrupt record listing, direct per-App forget preview, explicit plan-field comparisons, shell-safe rerun hints and clearer manual-step usage. Existing stdin-ignored/no-timeout policy is documented rather than changed.

Regression coverage includes realistic launch errors versus unexpected rejections, oversized output, signal exits, private directory/file modes, traversal-like App identities, corrupt records (including explicit forget of a corrupt selected record), argv-only manual completion rejection and shell quoting. Existing CLI tests cover duplicate/unknown flags, incompatible forget flags, selection arity and unconfirmed forget.

Verification after corrections: `pnpm typecheck` and `pnpm lint` passed; `pnpm test` passed 558 tests with 0 failures/skips. Focused lifecycle (11), App CLI (8) and process runner (5) tests passed. Diff whitespace check passed.
