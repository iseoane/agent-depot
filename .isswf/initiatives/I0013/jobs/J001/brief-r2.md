# Job brief I0013/J001 r2 (correction cycle 1; operator decisions 2026-10-29)
Same worktree and authorization as r1, plus README.md edits. Read V001.md here.

## Operator decisions
1. Package approve/confirm/forget panels: **paging only**. Remove the "Scroll to end before y" gate: `y` is accepted from any page. Keep paging, the `Review N of M` indicator and the "more content" indication. Keep the full-view layout and new titles. App/recipe/Updates gates stay as they are (do not touch).
2. Profile import/export `y`: unchanged (already from any page with indicator). No change.
3. Fix F1: the export name stage must show the END of Folder and Destination at small heights (keep tail or reserve ≥3 rows for first+last); add an assertion that the end is visible at the tested height. Make comment and CHANGELOG accurate.
4. Fix F2: README — Installations/Catalog keys describe Package panel paging; picker `p` view paging; replace "shows the complete destination path" with accurate wording.
5. F5: reword the CHANGELOG line about the profile confirmation paging.
6. Fix the 3 e2e tests failing at a long TMPDIR (also failing on main): "narrow recipe approval keeps all execution terms reachable before consent", "the narrow TUI keeps recipe approval separate from confirmed App installation and updates", "the Xeo semantic palette reaches colored text in a real terminal". Diagnose (isswf-debug: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-debug/SKILL.md) whether test fragility or a product defect; fix accordingly; red first at a 42+ char TMPDIR.
7. Optional nits F3 (question array order consistent with app-actions; catalog-view indentation; remove now-unreachable PackagePanel if dead).

## Evidence
isswf-tdd red-first for 1 (a test that `y` on page 1 now approves) and 3, and the e2e fixes. Linux typecheck/lint/test/test:e2e at default and 42+ char TMPDIR; Windows CI green; record run ID. Commits fix(tui)/test/docs, no attribution. Report A002.md.
