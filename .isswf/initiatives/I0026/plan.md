# I0026: Windows local test tooling (issues #90, #91, #92)

Type: bug

## J001
- Status: pending
- Objective: Make the four TUI frame-timeout tests from #90 pass reliably on Windows without hiding real failures.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: Triage prepared; awaiting an explicit operator start instruction.

### Acceptance
- See the triage brief: diagnosis identifies why each test times out under load, then load-independent waits; two consecutive full local Windows runs show 0 of these failures.

### Evidence
- Operator 2026-11-07: «coordinador haz el triage de las issues que agent-depot». Open issues: #90, #91, #92 (all needs-triage).

## J002
- Status: pending
- Objective: Make `pnpm test:single` map `.ts`/`.tsx` test paths correctly on Windows (Git Bash, PowerShell) and Linux (#91).
- Depends on: None
- Brief: [brief-r1.md](jobs/J002/brief-r1.md)
- Blocker: None
- Next step: Triage prepared; awaiting an explicit operator start instruction.

### Acceptance
- See the triage brief.

### Evidence
- Same operator triage request.

## J003
- Status: pending
- Objective: Find why the local Windows e2e pty fails with AttachConsole, then make the first journey run or skip it explicitly on win32 (#92).
- Depends on: None
- Brief: [brief-r1.md](jobs/J003/brief-r1.md)
- Blocker: None
- Next step: Triage prepared; awaiting an explicit operator start instruction.

### Acceptance
- See the triage brief.

### Evidence
- Same operator triage request.
