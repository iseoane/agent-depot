# I0003: Triage of open issues (2026-10-29)

Type: triage. Labels pending operator confirmation.

| Issue | Proposed | Evidence checked |
|---|---|---|
| #50 Pi lock `bin` rejected | ready-for-agent (bug, priority 1) | allowlist at src/package-host-state.ts:449 lacks `bin`; ADR 0009 constraints stated in issue |
| #45 flaky ENOTEMPTY | ready-for-agent (bug) | `void reload()` on Esc at src/tui/sources-recipes.tsx:212 confirmed |
| #48 test gaps | ready-for-agent | only WSL case covered (tests/package-flow.test.ts:648); test:single regex `\.ts$` confirmed |
| #44 CLI progress | ready-for-agent | dependency #43 merged (a0ae7e4); line refs must be re-verified |
| #46 Windows CI | ready-for-human | CI all ubuntu-latest; needs operator decision on runner cost and first-run debugging on real Windows |
| #47 Windows kill tree | ready-for-agent, blocked by #46 | child.kill() at src/process-runner.ts:107,114,128; verification needs win32 CI |

Suggested order: #50 → #45 → #48 → #44; #46 then #47.

## Applied 2026-10-29
Labels and evidence comments applied to #44-#48 and #50 (operator approved).

## Open points carried from earlier initiatives
- I0001/I0002 records said awaiting-human, but PRs #42 and #43 are merged; statuses updated to done.
- #42 real-Windows check: partly covered by the #50 report (Pi install runs on Windows); systematic coverage is #46.
- #43 residual: real-terminal visual check, and braille spinner rendering on Windows, not verified. Not tracked in an issue.
- #44 excluded live child-process streaming; a separate issue was suggested but never created.
- Created follow-ups: https://github.com/iseoane/agent-depot/issues/51 (spinner real-terminal/Windows check), https://github.com/iseoane/agent-depot/issues/52 (child-process streaming).
- Operator 2026-10-29: low-risk PRs may be merged into main without asking, after passing review and green CI.
- Operator 2026-10-29: accepts Windows CI cost for #46 → ready-for-agent. Queue: #44 → #46 → #47.
- Operator 2026-10-29: #54 and #52 ready-for-agent (#52 = tail of last lines); #51 left pending in needs-triage. Queue: #46 + #47 (parallel) → #54 → #52.
- Operator 2026-10-29: #52 also includes a global --verbose flag (full child output to stderr, no spinner).
- 2026-10-29: #58 ready-for-agent (low priority), queued after #52.
