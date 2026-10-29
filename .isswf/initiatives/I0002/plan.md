# I0002: TUI progress indicator for every wait

Type: enhancement

This coordinator-owned plan records reported progress, not execution permission or process liveness.

## J001

- Status: done (PR merged)
- Objective: Every TUI wait shows an animated spinner, a specific label and elapsed time from 1s
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md) (pending until prepared)
- Blocker: Operator decision: real-terminal visual check and integration of PR #43
- Next step: Operator checks the spinner in a real terminal and decides on merging PR #43

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
- Reviews V001 (changes required, dispositioned) and V002 (pass)
- jobs/J001/delivery.md
- PR https://github.com/iseoane/agent-depot/pull/43 head ca0db1d063ec3fc32d3efb35900b3a937023e702; CI run 40766075428 check and pack pass

## J002

- Status: done (PR merged)
- Objective: A real-PTY e2e journey proves the indicator animates, shows elapsed time and clears, with animation on
- Depends on: J001
- Brief: [brief-r1.md](jobs/J002/brief-r1.md) (pending until prepared)
- Blocker: Operator decision: real-terminal visual check and integration of PR #43
- Next step: Operator checks the spinner in a real terminal and decides on merging PR #43

### Acceptance

- New e2e runs with animation enabled and asserts spinner advance, elapsed >=1s and disappearance by text, not exact frames
- Existing palette test waits for fixture-app: cancelled before sending 3
- pnpm test:e2e passes repeatedly in static and animated modes

### Evidence

- jobs/J002/brief-r1.md
- jobs/J002/A001.md
- Commit db8c1bf; coordinator e2e animated 12/12
- e2e 12/12 default and animated on d20016c (coordinator)
- PR https://github.com/iseoane/agent-depot/pull/43
