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
