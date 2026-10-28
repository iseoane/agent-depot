# I0002: TUI progress indicator for every wait

Type: enhancement

This coordinator-owned plan records reported progress, not execution permission or process liveness.

## J001

- Status: in-review
- Objective: Every TUI wait shows an animated spinner, a specific label and elapsed time from 1s
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md) (pending until prepared)
- Blocker: None
- Next step: J002 animated e2e journey, then independent review of the full candidate

### Acceptance

- AC1 every busy/loading state renders through Working, including previously silent waits
- AC2 no generic Working... or misleading Loading Profile during import apply
- AC3 elapsed survives label changes within one operation and restarts for a new one
- AC4 no timer outlives unmount; timers unref'd
- AC5 one spinner per screen
- AC6 typecheck, lint, test and TUI e2e pass

### Evidence

- jobs/J001/research.md
- jobs/J001/planning.md
- jobs/J001/brief-r1.md
- jobs/J001/A001.md
- Coordinator checks on 06408d2: typecheck, lint, test 1076/1076, e2e 11/11

## J002

- Status: pending
- Objective: A real-PTY e2e journey proves the indicator animates, shows elapsed time and clears, with animation on
- Depends on: J001
- Brief: [brief-r1.md](jobs/J002/brief-r1.md) (pending until prepared)
- Blocker: None
- Next step: Dispatch worker following isswf-e2e

### Acceptance

- New e2e runs with animation enabled and asserts spinner advance, elapsed >=1s and disappearance by text, not exact frames
- Existing palette test waits for fixture-app: cancelled before sending 3
- pnpm test:e2e passes repeatedly in static and animated modes

### Evidence

- pending
