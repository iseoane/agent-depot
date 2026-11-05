# I0023: Fix removal of other-platform App recipes and recipe row follow-ups

Type: bug

## J001
- Status: ready
- Objective: Let a recipe for another platform be removed even when an App of the same name is tracked here, and close the I0021 review follow-ups on Sources recipe rows.
- Depends on: I0021 (merged 9980c20)
- Blocker: None
- Next step: Start after I0022 (operator order I0022 -> I0023 -> I0024 -> I0019).

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
