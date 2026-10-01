# 03: TUI tab "5 Import/Export"

**What to build:** A fifth TUI tab after Updates. Export: checklist grouped by Sources / Skills / Apps, preview, and a path prompt to write the file. Import: path prompt, plan shown as a checklist (add items checked, same and conflict shown but not selectable), preview, y/n, and a per-item result summary. Both call the shared core from tickets 01 and 02.

**Blocked by:** 01, 02.

**Status:** ready-for-agent

- [ ] Export and import reuse the existing checklist, preview panel and y/n confirmation.
- [ ] Sources, Catalog, Installations and Updates are unchanged; view keys 1–4 keep their meaning and 5 opens the new tab.
- [ ] Errors from the core are shown without crashing the TUI.
