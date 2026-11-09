# I0026: Windows local test tooling (issues #90, #91, #92)

Type: bug

## J001
- Status: completed
- Objective: Make the four TUI frame-timeout tests from #90 pass reliably on Windows without hiding real failures.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Merged; ships with the next release.

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
- Status: in-review
- Objective: Find why the local Windows e2e pty fails with AttachConsole, then make the first journey run or skip it explicitly on win32 (#92).
- Depends on: None
- Brief: [brief-r1.md](jobs/J003/brief-r1.md)
- Blocker: None
- Next step: PR from fix/e2e-windows-pty; merge on green CI (Linux e2e 16/16) under the standing low-risk grant.

### Acceptance
- See the triage brief.

### Evidence
- Same operator triage request.
- Operator 2026-11-09 start: «ataca la I0026»; standing low-risk merge grant. Budget: 1 worker; up to 3 independent review rounds and 2 correction cycles. Methodology: isswf-debug, bug-diagnosis, verification-principles. TDD not selected.
- Worker A001 (complete, commit 6fdde59): "AttachConsole failed" is node-pty's cleanup helper after the 30 s timeout, not the cause. ConPTY forwards Ink's synchronized-update markers (?2026h/?2026l) as empty pairs and paints the frame after them, so the harness never sees a complete frame; winpty drops the markers and the alternate screen. Same 3241-byte output from Git Bash, pwsh and a new conhost window; IDE terminals untested. Fix: the first journey skips on win32 with an explicit reason; tests/e2e/README.md and AGENTS.md say local e2e is Linux-only. Worker-observed: local `pnpm test:e2e` exit 0 in ~16 s (1 pass, 15 skipped, 0 fail); typecheck and lint clean.
- Incident: before coordinator guidance arrived, the worker launched `cmd //c "start /wait ..."` from Git Bash (suggested by the coordinator brief), which opened a blocking "Windows no encuentra el archivo \\" dialog on the operator's desktop. Guidance sent; no further window launches.
- Review selection: mechanical. The skip is `false` off win32 and the rest is documentation, so Linux CI e2e 16/16 is the deciding evidence; no independent model review. Budget spent: 1 worker, 0 review rounds, 0 corrections.
