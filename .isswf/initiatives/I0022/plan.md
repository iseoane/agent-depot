# I0022: Make Profile import readable and grouped

Type: enhancement

## J001
- Status: completed
- Objective: Make the TUI Profile import list understandable: group items and describe what importing each one will do in plain language.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None for J001 (merged c8ee4e9); follow-ups in J002.

### Acceptance
- Items grouped: Importable (by Source/repo, containing Skills, Packages, App recipes), Unchanged (`same`, collapsed by default), Conflicts (not selectable) with a one-line human reason (e.g. "hosts: would add codex, opencode") instead of raw JSON arrays.
- Plain labels stating the effect: e.g. "Add App recipe (not approved, not installed)", "Already identical", "Add Source", "Select Package".
- Selection, toggle-all and preview semantics unchanged; preview/confirm still from core `profile-import.ts` (ADR 0006): classification stays in core, presentation in the view.
- Focused TUI tests with injected profile fixtures under isolated-env.

### Evidence
- Operator 2026-11-05 screenshot of Import Profile: flat list of 38 rows, raw `hosts: existing [...] → incoming [...]`, "(not selectable)" suffixes; operator: «es ilegible... no sabes que va a hacer con cada una» and asked why recipes cannot be imported.
- Coordinator code check: recipes ARE importable (`src/profile-import.ts` classifyRecipe returns `add`/`conflict`; writeRecipe writes `profile-<sha256>-<uuid>.json`). The rows shown were `same` because they had already been imported earlier (matching the `profile-*.json` files in Installations). Label "unapproved; Apps are not installed" (`src/profile-import.ts:116-118`) reads as if nothing is imported; rewrite it.
- Operator accepted this scope: «3. OK».
- Operator start: «ese orden me parece correcto! encargate coordinador!»; low-risk merge grant in force. Budget: 1 worker, 1 reviewer, 1 correction cycle. Surface verified by coordinator: TUI Profile import (src/tui/profile-view.tsx) + core labels (src/profile-import.ts).
- Process gap found by operator question (2026-11-05): worker traces for I0018 J005, I0020, I0021 show no reads of roles/references/code-quality.md, comments.md, tdd.md, verification-principles.md (and bug-diagnosis.md for I0020), although worker.md step 4 requires code quality + comments for code changes. Coordinator briefs listed only role + isswf-tdd as selected methodology. Reviewer traces are empty (0 bytes), so reviewer resource consumption is self-reported only. Live guidance sent to the I0022 worker to load and apply those references (separate commit if code changes). Operator: «no tu no fuerces nada, eso es cosa de isswf!!» — no project-level workaround; gap belongs to isSWF.
- Worker: RED ac6cd7a (core 3 fail, TUI 8 fail incl. 1 EPERM; worker-observed), GREEN 520656f, REFACTOR b1821f4 (code-quality pass: type guard). Self-reported reads of comments/code-quality/tdd/verification-principles, CONTEXT, ADR 0006/0008 after live guidance; trace file 0 bytes (unverified). pnpm audit:all not completed (timeout). Coordinator at b1821f4: build/typecheck/lint pass; profile-import, profile, cli, tui-profile: 165 pass, 1 fail (known EPERM 'export refuses … dangling symlink'). CLI impact: only recipe label wording; CLI conflict lines still raw (follow-up).
- Independent review R1 (Agent-tool reviewer, opus, not bound): Standards PASS, Spec PASS, risk LOW, 0 blocking. Follow-ups: F1 Unchanged/Conflict Skill rows ambiguous across Sources (basename only); F2 Package version reason says "installed" for a recorded selection (use "existing"); F3 Enter on header opens group (empty-plan preview needs moving to an item); CLI conflict lines still raw. Coordinator confirmed RED ac6cd7a touches tests only.
- PR #82 https://github.com/iseoane/agent-depot/pull/82 opened at b1821f4; merge under low-risk grant after green exact-head CI.
- CI 42083687413 on b1821f4: Linux check FAILURE — e2e 'wrapped Profile preview … narrow PTY' (40x17): per-Source group header wraps 3 lines, title 'Import Profile' pushed out, item row label empty ('[x] 2'). Real narrow-width regression. Correction 1/1 sent to the same worker (single-line truncated headers, non-empty item rows, height reserve; unit regression at 40 cols). Pending operator: follow-ups F1-F3 + CLI raw conflicts as I0022 J002 before I0023.
- Operator: «si y una vez este I022 integrada, para de momento no vamos a hacer por hoy mas!» — J002 (follow-ups F1 cross-Source ambiguous rows, F2 "existing" wording, F3 Enter on header with empty plan, CLI plain conflict reasons) authorized after J001 merge; stop all work once I0022 is integrated. I0023/I0024/I0019 not started today.
- Correction 1/1: RED 9a2df7c (tests only; worker-observed: title missing, '> [x] 2'), GREEN 99e1c85 (one-row clipped group headers). Coordinator at 99e1c85: build/typecheck/lint pass; tui-profile, profile-import, profile, cli: 166 pass, 1 known EPERM.
- CI 42085919593 on 99e1c85: Linux check SUCCESS (narrow-PTY e2e fixed), pack SUCCESS, Windows FAILURE in unrelated tests/app-flow.test.ts 'approval receipts use canonical file identity and private atomic storage' — EPERM on concurrent atomic rename (Promise.all approve; src/atomic-file.ts). Not touched by this PR; passed on b1821f4. One failed-job-only rerun issued. Candidate for I0024 (Windows test robustness) or a real atomic-file Windows race to investigate.
- Windows failed-job rerun of 42085919593: SUCCESS (all jobs green on 99e1c85). J001 merged with matching head (PR #82).

## J002
- Status: completed
- Objective: Close the J001 review follow-ups in Profile import.
- Depends on: J001 (merged c8ee4e9)
- Brief: [brief-r1.md](jobs/J002/brief-r1.md)
- Blocker: None
- Next step: None. Initiative closed; ships with the next release.

### Acceptance
- F1: Unchanged and Conflict Skill rows are unambiguous across Sources (show the Source/repo when the same Skill name appears in more than one Source, or always in those flat sections).
- F2: Package (and any non-installed-state) version conflict reason says "existing X, profile Y" instead of "installed".
- F3: with no selectable rows (everything Unchanged/Conflict), Enter still opens the confirm/preview path without needing to move to an item row (Enter on group headers keeps opening/closing otherwise).
- CLI: `agent-depot import` preview/result conflict lines use the plain reason (`hosts: would add …`) instead of raw JSON arrays, keeping the `add:/same:/conflict:` prefixes; CLI tests updated.
- Focused tests; no change to selection, recheck or write paths.

### Evidence
- J001 independent review F1-F3 and CLI note; operator: «si» to doing them as J002 now, then stop after I0022.
- Worker: RED 923a7f2 (tests only; worker-observed 3 core + 1 TUI behavioural failures), GREEN cb331e1. Coordinator at cb331e1: build/typecheck/lint pass; tui-profile, profile-import, profile, cli: 170 pass, 1 known EPERM; no stray python processes. Review dispatched.
- Review R1 (Agent-tool, opus): Standards PASS, Spec PASS, risk LOW. S1 CHANGELOG added by coordinator (83d18b5, docs only). S2 accepted trade-off (conflict lines show short reason only; conflicts always skipped). PR #83 https://github.com/iseoane/agent-depot/pull/83 at 83d18b5.
- CI 42093978579 on 83d18b5: check/windows/pack SUCCESS, audit SKIPPED. Merged with matching head (PR #83). I0022 closed; operator stop point reached.
