# I0028: Package root labels outside Updates (I0027 follow-ups)

Type: bug

## J001
- Status: in-progress
- Objective: No user-facing Package text renders a Source-root Package as `.` or `name@.`: Profile export/import previews and Package flow failure reasons use a root-aware spelling; README documents Enter on the "cannot be checked" line.
- Depends on: I0027 (merged e79dad6)
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: PR, exact-head CI, low-risk merge.

### Acceptance
- See brief.

### Evidence
- I0027 V002 non-blocking findings 1, 2, 4.
- Operator 2026-11-08: «¿podemos corregirlos?» → «si y atacala»; «dejemos todo cerrado menos los pendientes de windows». Feature-to-PR start with low-risk merge. Budget: 1 worker, up to 3 review rounds / 2 correction cycles. Branch fix/package-root-labels from 8b34a1d. No planner: small, mapped change.
