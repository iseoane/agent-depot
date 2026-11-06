# I0023: Fix removal of other-platform App recipes and recipe row follow-ups

Type: bug

## J001
- Status: completed
- Objective: Let a recipe for another platform be removed even when an App of the same name is tracked here, and close the I0021 review follow-ups on Sources recipe rows.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Initiative closed; ships with the next release.

### Acceptance
- S1 (bug): `planAppRecipeRemoval`/`removeAppRecipe` (src/app-recipe-removal.ts:46,55,75) must not treat a non-applicable recipe as installed just because an App with the same name is tracked; match tracking by recipe file (canonical) or ignore name-only tracking when the recipe does not apply here. No uninstall question for it. ADR 0007: "a recipe for another platform … stays removable". Regression with a tracked record (e.g. codegraph tracked from the windows recipe, remove the linux recipe on Windows).
- S2: clashing duplicate recipe rows in Sources are distinguishable (show file name for rows grouped by file / with error), and the error/preview names the files to repair.
- S3: when no recipe of a name applies here, the row shows the primary recipe's platform before its status.
- I2: unused export `recipeMemberLine` made module-private (fallow).
- I4: decide "✓" in the status badge per the accepted mock-up; fix stale e2e comment (tests/e2e/tui.e2e.test.ts:341).
- Picker tests: cancel (n/Esc), picking the applicable recipe, out-of-range digit.

### Evidence
- I0021 independent review (PR #81): S1 pre-existing high-confidence finding by code reading; S2, S3, I2, I4 introduced/minor.
- Operator accepted: «Ok» to create I0023 and order I0022 -> I0023 -> I0024 -> I0019.
- Worker (sonnet): RED 90bf529 (tests only; worker-observed plan.installed true vs false; carried a lint error fixed in cd78aa1), GREEN 3216585 (tracked record counts only when the recipe applies here or record.recipeFile matches canonicalFile), cd78aa1 S2 file names in clashing rows and duplicate error, S3 platform before status, I2 recipeMemberLine private, I4 "✓ approved" + e2e comment, picker tests (n, Esc, out-of-range, pick applicable). Self-reported reads: worker, comments, code-quality, isswf-tdd. Worker full suite Windows: 1244 tests, fail 4 (known TUI frame timeouts). fallow audit and e2e not run.
- Coordinator at cd78aa1: build/typecheck/lint pass; app-recipe-removal, tui-sources-app-groups, tui-sources-recipes, app-recipes: 43 pass, 0 fail, 1 skipped. Review R1 dispatched.
- Review R1 (Agent-tool isswf-reviewer, opus, not bound): Spec PASS, Standards FAIL (B1: e2e tests/e2e/tui.e2e.test.ts:354 expected green "approved", now "✓ approved"), risk low. S1 removal safety confirmed (applicable recipes keep name-based protection; live version check unchanged). Follow-ups: forget hint when a tracked recipe no longer applies; picker success-path TUI test; fallow run.
- Coordinator fixed B1 directly (c241e43, one assertion; within correction 1/1) and added CHANGELOG (39e88e2). Local Windows e2e cannot start pty (AttachConsole failed; environment, also first journey); Linux CI e2e is the verification. PR #86 https://github.com/iseoane/agent-depot/pull/86 at 39e88e2.
- CI 42292146879 on 39e88e2: Linux check first FAILED in unrelated tui retention test teardown (ENOTEMPTY rmdir in temp home; flaky teardown race); one failed-job rerun SUCCESS: test 1238 pass 0 fail, e2e 16 pass 0 fail (B1 fix verified). Windows/pack SUCCESS, audit SKIPPED. Merged with matching head as 15065c7 (PR #86); branch deleted.
