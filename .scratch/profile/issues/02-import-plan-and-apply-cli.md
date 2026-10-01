# 02: `agent-depot import` plan and apply

**What to build:** `agent-depot import <file> [--yes]` with the same filters as export. It builds a plan (add / same / conflict per item), previews it, and applies only the add items after confirmation: Sources, then Skills through the existing install flow, then App recipes written unapproved to the destination `apps/` directory.

**Blocked by:** 01.

**Status:** completed

- [x] Nothing present in the destination is removed, replaced or changed; conflicts are skipped and their difference is shown.
- [x] One item's failure does not stop the others; results are summarised per item.
- [x] Imported recipes are unapproved and Apps are never installed by import.
- [x] Without `--yes` nothing is written.

## Comments

Implemented shared `src/profile-import.ts` classification/apply and CLI import.
Source inclusion stays transient; filtered-out Source blocks do not force
registration for self-contained Skill identities. Recipe publication uses an
exclusive atomic hard link and a hashed identity plus UUID filename, preventing
overwrite, traversal and reuse of stale approval receipts. Apps never run.

Verification: `pnpm typecheck`, `pnpm lint`, import tests (7/7), profile
tests (21/21), CLI tests (70/70), full `pnpm test` (687/687). The import suite
executes the built CLI against an isolated, pinned local Git fixture with no
network access; it also exercises external-method execution after its preview.

Review baseline: `d0478692a90c310eefc05bf447b95fa834b5109e`. Standards and Spec
reviewed separately in-process because no sub-agent tool was available; no
unresolved findings. The review simplified the nested Skill installation branch.
Rollback boundary: remove the Profile import module/tests, import command/help,
shared filter/parser extraction and this README section; export behavior and
existing installation operations remain unchanged.

Review correction — App name safety: destination recipe names are reserved across
platforms, including invalid recipes whose JSON still gives a name; unknown-name
files produce warnings. Incoming overlapping applicability is rejected. Existing
file paths and per-key changes appear in conflicts. Imported user-owned recipe
JSON uses ordinary umask-governed file permissions, like Source JSON rather than
private approval receipts. Focused import tests: 9/9; profile tests: 22/22.
Rollback boundary: these recipe-name guards, field diagnostics and their tests.
