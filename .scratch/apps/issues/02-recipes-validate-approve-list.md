# 02: App recipes: load, validate, approve, and list via CLI

**What to build:** A user drops recipe JSON files into the per-user `apps/` directory. Agent Depot provides:
- `agent-depot app schema` prints the recipe JSON Schema.
- `agent-depot app validate <file>...` validates recipes.
- `agent-depot app list` shows the recipes that apply to this environment: installed version, resolved executable path, needs-approval or invalid state.
- Approving a recipe once, keyed on a hash of its content, permits its `version` command to run.

**Blocked by:** 01.

**Status:** completed

- [x] Recipes are selected by `platform` (WSL counts as linux). A recipe without `platform` applies everywhere. Two applicable recipes with the same `name` are an error.
- [x] Each step is `argv`, `manual`, or both. `argv` follows the existing no-shell user-method rules. `manual` text is never executed.
- [x] No command from an unapproved or changed recipe runs. The approval preview lists every argv in the recipe.
- [x] `version` uses its pattern to extract the installed version. An unresolvable version means "not installed".
- [x] On WSL, an executable that resolves under `/mnt/<drive>/` is treated as not installed and is never run.
- [x] `validate` reports recipes for other platforms as not applicable here.


## Decisions

- Recipes live in `apps/` beside the existing environment-local `sources.json`, not a new config root (Open Question 1).
- Approval uses exact file-content SHA-256 plus canonical realpath file identity, stored in sibling `app-approvals/`; changed bytes require renewed approval (Open Question 5).
- CLI adds `app approve <name> [--yes]`; only `app approve <name> --yes` records approval. Validation rejects `--yes`, previews but executes only previously approved version commands. This supersedes the initial validate-with-approval decision after review (Open Question 3).
- WSL manages Linux only; Windows executables under `/mnt/<drive>/` are never run (Open Question 6).
- Latest resolution, lifecycle execution, Windows manual fallback and teardown policy are deferred to their dependent tickets, not decided here.

## Verification

- Pre-agreed seams: public recipe/core operations and CLI, injectable executable resolution and command runner, temporary per-user directories.
- TDD red: missing recipe/core modules and unknown CLI command; green: focused recipe, approval/inspection and CLI tests. Regression red: a newly added duplicate could run through a stale approved entry; green: recheck current directory before inspection.
- `pnpm test:single tests/app-recipes.test.ts`: 2 passed.
- `pnpm test:single tests/app-flow.test.ts`: 4 passed.
- `pnpm test:single tests/app-cli.test.ts`: 2 passed.
- `pnpm test:single tests/cli.test.ts`: 70 passed.
- `pnpm test:single tests/version.test.ts`: 8 passed.
- `pnpm typecheck`, `pnpm lint`, `git diff --check`: passed.
- `pnpm test`: 529 passed, 0 failed.
- Runtime harness: built CLI with isolated XDG state and PATH executable fixture; list reported needs approval, approve preview showed every step, approved list reported installed `1.2.3` and absolute executable. No real App or user state modified.

## Code review

Fixed point: `491c5a5bc99046d3fbe4e77c603e26271e3303f7`.
Standards and Spec reviewed separately in-process; parallel sub-agent tooling unavailable.

### Standards

No remaining documented-standard violations or actionable baseline smells. Portable argv validation is reused, the runner is injectable, and CLI delegates plans/previews/approval/inspection to the shared core (ADR 0006). Help ordering and exact-output compatibility regressions found by verification were corrected.

### Spec

All six ticket acceptance criteria implemented. Approval gates recipe commands, hashes exact bytes, previews lifecycle/version/latest/setup/teardown argv, rejects applicable duplicates and prevents WSL Windows executable execution. Latest lookup and lifecycle writes are intentionally outside ticket 02. No remaining findings.

## Work units and rollback

- `8eba6fc`: recipe parsing and argv validation with tests; rollback `src/app-recipes.ts` and its focused test (dependent App flow must also be reverted). Focused tests: 2 passed. Runtime boundary: N/A, pure parsing.
- `4577f96`: approval/environment inspection with tests; rollback `src/app-flow.ts` and its test plus dependent CLI. Initial focused tests: 2 passed; final expanded coverage: 4 passed. Runtime harness above covers approval/version behavior.
- `201869f`: schema/CLI/documentation integration; rollback App CLI/schema, CLI App registration/dependency/help, README App section and integration tests; retain unrelated skill flows. Initial CLI focused test: 1 passed; final coverage: 2 passed. Runtime harness above covers CLI registration and output.
- Final verification unit keeps help compatibility, expanded regression tests and this completed ticket together; rollback only those changes without removing App behavior.

## Review corrections

Applied all feedback from `t02-review.md` against `597ab9b` with failing regression tests before behavior changes.

- WSL skips Windows drive realpaths and continues scanning PATH; runner receives the candidate path (not realpath), exact argv tail and home cwd. Blocked previews explain that Windows executables will not run.
- External-file validation is independent of apps-directory duplicates; internal-file validation and inspection use consistent directory duplicate checks.
- Approval receipts use canonical file identity, private directory/file permissions and atomic temp-plus-rename writes. Extracted the existing source-state write logic into a shared helper; preserved its locked Windows fallback only for source state, never receipts.
- Schema uses canonical Host keys. Parser compiles patterns before capture counting, prefixes errors with field paths, rejects invalid platform types and uses a clear skills loop.
- Validation rejects `--yes`; only explicit single-name approval records a receipt. Unknown names fail normally; malformed CLI input remains a usage error.
- Added all requested capture, platform, preview, spawn, byte-invalidation/restoration, parse-at-load, CLI/list/manual and mount-boundary coverage. Expanded dense fixtures and isolated all test receipt directories under temporary roots.
- Resolved spec Open Questions 1, 5 and 6; synchronized README, DESIGN and ADR 0007 with the approval contract.

### Final verification

- `pnpm test:single tests/app-flow.test.ts`: 11 passed.
- `pnpm test:single tests/app-recipes.test.ts`: 5 passed.
- `pnpm test:single tests/app-cli.test.ts`: 5 passed.
- `pnpm test:single tests/sources.test.ts`: 21 passed after shared atomic-writer extraction.
- `pnpm typecheck`, `pnpm lint`, `git diff --check`: passed.
- `pnpm test`: 542 passed, 0 failed.
- Runtime harness: isolated XDG state, executable symlink fixture whose behavior depends on its invocation name. `validate --yes` rejected; unconfirmed approval wrote nothing; confirmed approval/list reported installed `1.2.3` via the candidate path. Receipt directory/file permissions were `700`/`600`.
- Rollback boundaries: resolution/storage work removes the shared atomic writer extraction and restores prior App resolution/receipts; parser work restores prior schema/parser diagnostics; CLI work restores prior approval grammar and its documentation. Tests accompany each behavior unit. No push or PR.
