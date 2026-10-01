# 03: TUI tab "5 Import/Export"

**What to build:** A fifth TUI tab after Updates. Export: checklist grouped by Sources / Skills / Apps, preview, and a path prompt to write the file. Import: path prompt, plan shown as a checklist (add items checked, same and conflict shown but not selectable), preview, y/n, and a per-item result summary. Both call the shared core from tickets 01 and 02.

**Blocked by:** 01, 02.

**Status:** completed

- [x] Export and import reuse the existing checklist, preview panel and y/n confirmation.
- [x] Sources, Catalog, Installations and Updates are unchanged; view keys 1–4 keep their meaning and 5 opens the new tab.
- [x] Errors from the core are shown without crashing the TUI.

## Implementation evidence

- Public App/ProfileView tests use isolated temporary homes; export refusal, import conflicts,
  unapproved recipes, method argv, unregistered Sources, newer versions and windowing covered.
- Review base: d577a98c543ce352831309d6e2e7d76203165beb. Local Standards and Spec review
  (parallel sub-agents unavailable): no unresolved findings. Shared export file creation
  avoids frontend safety drift; subset previews recompute Source warnings.
- Rollback boundary: fifth tab, ProfileView, profile TUI tests and README additions;
  shared export helpers can be reverted with their CLI callers, independently of existing tabs.
- Verification: pnpm typecheck, pnpm lint, pnpm test, pnpm test:e2e.

## Review corrections

- Applied every item in `p03-review.md`: classified core exclusions/warnings, real
  group headers and plain exclusions, helper extraction and input/confirmation
  cleanup, mode-specific scroll hints, and consistent empty-export refusal.
- Empty Profile parsing remains supported; core file creation and CLI stdout export
  reject an empty selection. TUI stops before the destination prompt.
- Red/green evidence: empty writer rejection and structured-diagnostic tests failed
  before core fixes; group-header, empty-selection and browse-hint tests failed
  before UI fixes. Expanded interaction tests caught empty Enter inserting `\r`
  into paths; both prompt tests passed after guarding Enter separately.
- Regression coverage includes pasted paths, q/digit capture, Backspace, empty Enter,
  prompt/checklist cancellation, space/all toggles, subset Source warnings, same
  item reasons, successful/failed Source/Skill summaries, invalid JSON/profiles,
  and busy key suppression using only a gated Git command runner.
- Work units: `c084e5b` core export diagnostics/empty-artifact safety; `1b177a8`
  grouped TUI choices/state clarity; final input fix with expanded public-seam tests.
- Focused verification: core Profile tests 24 passed; App + grouped Profile tests
  20 passed; expanded Profile interaction tests 16 passed.
- Final verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (718 passed),
  `pnpm test:e2e` (3 passed), and `git diff --check` passed.
- Runtime harness: real-terminal e2e walks key 5 and all unchanged views.
- Rollback boundaries: core diagnostics/writer/CLI and corresponding core tests;
  ProfileView grouping/helpers/App hints and their tests; empty-Enter guard and
  the expanded interaction-test unit. No push or PR.
