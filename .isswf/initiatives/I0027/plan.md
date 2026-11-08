# I0027: Updates view grouped by Source (issue #93)

Type: enhancement

## J001
- Status: completed
- Objective: Show the Updates view as a collapsible tree by Source (Packages / Skills) plus an Apps group, with group selection, so Package rows name their Source instead of `.` (#93).
- Depends on: None
- Brief: [brief-r3.md](jobs/J001/brief-r3.md)
- Blocker: None
- Next step: None. Initiative closed; ships with the next release.

### Acceptance
- See the triage brief.

### Evidence
- Operator 2026-11-07: «hazle ya el triage» on #93, with decisions recorded in its comments (group selection, top-level Apps group, implementer chooses reuse).
- Operator 2026-11-08: «haz la I0027, solo esa, ya sabes si el riesgo sale bajo, la integras directamente». Feature-to-PR start; low-risk merge per project-setup. Budget: 1 planner, 1 worker, up to 3 review rounds / 2 correction cycles. Branch feat/93-updates-by-source from 74cd929 (sequential, primary checkout). Factory root: loaded plugin isswf 1.6.1 (setup record names 1.8.0, not present in cache).
- Delivered: PR #94 merged as e79dad6 (CI 42508382153 green on exact head); see jobs/J001/delivery.md. Follow-ups → I0028.
