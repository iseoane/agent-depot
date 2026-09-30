# E2E lifecycle test and inventory symlink noise

Goal: (1) commit a hermetic end-to-end lifecycle test of the built CLI; (2) stop `update check --scope user-global` from listing the Claude symlinks Agent Depot itself creates under "Skipped/unsafe entries".
TDD: strict (source: user instruction). Runner: `pnpm test` / `pnpm test:single tests/<f>.test.ts`. Checks per commit: `pnpm typecheck && pnpm lint && pnpm test`; final `pnpm audit:all`.
Delivery: branch test/e2e-lifecycle-and-symlink-noise; work-unit commits; no push, no merge.

- [x] Task 1: Add `tests/e2e-lifecycle.test.ts` (characterization, GREEN on current behavior).
- [x] Task 2: Inventory noise fix (strict TDD) plus e2e assertion that the noise is gone.
- [x] Task 3: Record this feature document.

## Task 2 progress / evidence
- Root cause: `classifySymlink` in `src/user-global-skill-inventory.ts` pushed a managed exposure symlink into `skipped` (reason `managed-canonical-alias`), and `cli.ts outputUpdateAssessment` renders every `skipped` entry under "Skipped/unsafe entries ... inspect them manually".
- Project scope is not affected: the inventory is only scanned for `update check --scope user-global`.
- Change: new `exposures` list on the inventory. A symlink under `~/.claude/skills/<name>` whose target is exactly `~/.agents/skills/<name>` (direct child, same name, real directory with a real SKILL.md) is an exposure when the canonical directory is managed or is a listed inventory entry. The `managed-canonical-alias` skip reason is removed. Everything else (different name, dangling, outside the roots, canonical target that is not a listed real Skill) is still reported as skipped. Removal inspection and unmanaged deletion are untouched and still refuse symlinks (exposures are never entries).
- RED: the updated/new inventory tests failed first (compile error on missing `exposures`, then with a stub returning `[]`: 3 failures). GREEN after the fix: 15/15 in the file, 213/213 overall.
- Tests: `tests/user-global-skill-inventory.test.ts` (managed exposure, listed unmanaged exposure, non-exposure symlinks still skipped).
- Commit: 7329f89 fix(inventory): stop reporting Agent Depot Claude exposure symlinks as skipped entries.

## Task 1 progress / evidence
- Route: delegated writer (single bounded writer). Everything runs in one mkdtemp sandbox: HOME, XDG_STATE/CONFIG/CACHE_HOME, GIT_CONFIG_GLOBAL (url.insteadOf https://example.test/src/source.git to a local file:// repo), GIT_CONFIG_NOSYSTEM=1; no network; removed in an `after` hook.
- Covers source add/list/refresh, discover, project and user-global install (canonical dir, symlink, manifest), reinstall refusal, missing skill/source errors, update check/refresh/apply, non-canonical adopted update, hostile manifest rejection, overwrite conflict with retained backup, unmanaged removal, source remove --skill, uninstall --skills/--data/--cli.
- Result: 9 cases GREEN on first run (pure characterization); includes the assertion that user-global `update check` has no "Skipped/unsafe" section for Agent Depot's own symlinks.
