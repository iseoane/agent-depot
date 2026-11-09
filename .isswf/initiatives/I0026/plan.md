# I0026: Windows local test tooling (issues #90, #91, #92)

Type: bug

## J001
- Status: in-review
- Objective: Make the four TUI frame-timeout tests from #90 pass reliably on Windows without hiding real failures.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: PR from fix/tui-frame-timeouts; merge on green CI under the standing low-risk grant.

### Acceptance
- See the triage brief: diagnosis identifies why each test times out under load, then load-independent waits; two consecutive full local Windows runs show 0 of these failures.

### Evidence
- Operator 2026-11-07: «coordinador haz el triage de las issues que agent-depot». Open issues: #90, #91, #92 (all needs-triage).

## J002
- Status: completed
- Objective: Make `pnpm test:single` map `.ts`/`.tsx` test paths correctly on Windows (Git Bash, PowerShell) and Linux (#91).
- Depends on: None
- Brief: [brief-r1.md](jobs/J002/brief-r1.md)
- Blocker: None
- Next step: None. Merged; ships with the next release.

### Acceptance
- See the triage brief.

### Evidence
- Operator 2026-11-09: «coordinador, completemos el arreglo de self update y luego ataca la I0026» (start, feature-to-PR) and «si las PR son de riesgo bajo integra sin pedirme permiso» (standing low-risk merge grant). Budget: coordinator implements directly (small, mapped change), 0 workers; mechanical/empirical verification, no model review.
- Reproduced 2026-11-09 under Git Bash: `pnpm test:single tests/self-update.test.ts` → "Could not find 'dist/tests/self-update.test.ts'" (the `.ts` → `.js` replace did not survive shell escaping).
- Fix: mapping moved to `scripts/test-single.mjs` (`compiledTestPath`), unit test `scripts/test-single.test.mjs` (3 pass), wired into Linux and Windows CI jobs.
- Local Windows: Git Bash `tests/atomic-file.test.ts` 4/4 pass; `tests/tui-profile.test.tsx` 31 pass, 1 pre-existing skip, 0 fail; PowerShell `testsatomic-file.test.ts` 4/4 pass, exit 0; missing file → clear message, exit 1. `pnpm typecheck` and `pnpm lint` clean.

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
