# 02: `agent-depot import` plan and apply

**What to build:** `agent-depot import <file> [--yes]` with the same filters as export. It builds a plan (add / same / conflict per item), previews it, and applies only the add items after confirmation: Sources, then Skills through the existing install flow, then App recipes written unapproved to the destination `apps/` directory.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Nothing present in the destination is removed, replaced or changed; conflicts are skipped and their difference is shown.
- [ ] One item's failure does not stop the others; results are summarised per item.
- [ ] Imported recipes are unapproved and Apps are never installed by import.
- [ ] Without `--yes` nothing is written.
