# I0017: Explain isSWF Package updates at unchanged manifest version

Type: bug

## J001
- Status: completed
- Objective: Explain why Pi and Claude isSWF Packages declared1.6.1 were offered updates and why Claude reports unchanged failure.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None; operator authorized the fix, delivered in J002.
- Result: [diagnosis.md](jobs/J001/diagnosis.md). Claude explicit version1.6.1 retains old cached commit despite newer marketplace; shared commit classifier offers an operation host cannot deliver. UI masks commit advances; Pi currently matches available Source HEAD, prior Pi exact commit unknown.

### Acceptance
- Distinguish current host version/commit, stored verified evidence and available source commit/version.
- Explain equal-version Git updates vs misleading labels and Claude unchanged evidence; mark historical unknowns.
- J001 research performed without updates, installs, refresh/network Git fetch, user-state mutations, config, implementation, remote writes or new model actors. Later operator authorizes J002 implementation independently.

### Evidence
- Operator explicitly authorized ok adelante con la investigacion after screenshot0.6.7 showing Pi1.6.1->1.6.1 and Claude unchanged failure.
- Base ca2242730380788d49e36a35a8974420df5cbdb0, local main, prior work complete. Direct coordinator investigation, no delegated actors or budgets borrowed from I0016.
- Filtered current records: Claude1.6.1 commit ce89f5ace1215b545c497369cfdc44074bbabbe5; Pi stored verified e2d3421157ec083d8a03e684c718285415574f0c. No pre-update Pi capture available.

## J002
- Status: completed
- Objective: Correct host-aware update eligibility and display actual version/commit evidence without modifying real installations.
- Depends on: J001
- Brief: [brief-r1.md](jobs/J002/brief-r1.md)
- Blocker: None. 0.6.8 publication verified 2026-11-05.
- Next step: None; initiative closed. Operator may update installed CLI separately (latest is now 0.6.9).

### Acceptance
- Versioned Claude respects explicit-version cache; Pi retains commit+ancestry semantics; unversioned/unknown/dirty evidence safe.
- Authorized project-review policy uses isswf-reviewer with canonical isswf-review Standards/Spec, no supporting code-review prerequisite (docs-only01ff2927+/1-).
- Updates, Installations and results display honest actual version and commit; remembered evidence not presented as current host truth.
- Focused regressions and required checks pass under isolated-env; independent review before publication-ready status.

### Evidence
- 2026-11-05 coordinator read-only verification: publish run 41837003290 completed success (verify/publish/tag success) on head 2ec4b38058c87a03510c2d69424588535cc64399; npm @iseoane/agent-depot@0.6.8 integrity sha512-Nia1k6FpLq8fohKxLwa7IOGxadLDig760V4xtsyBmtZp2T/PJhIGrSfkrB9J7Fei/posmeOtHjHoYpUGi4m14w==; GitHub Release v0.6.8 published 2026-11-04T13:24:20Z (not draft); annotated tag v0.6.8 peels to 2ec4b38. Superseded as latest by 0.6.9.
- Operator current trusted start: ok implmeneta la correcion after J001 diagnosis.
- Base ca2242730380788d49e36a35a8974420df5cbdb0, feature fix/package-host-update-evidence, same sole checkout sequential writer (no worktree).
- Native readiness: Pi1.5.0, pi-subagents0.83.0 registered+loaded; subagent list discovers project isswf-worker/reviewer; user settings worker openai/gpt-6-luna high, reviewer openai/gpt-6.1-sol medium. No config changes.
- Independent review round1 failure source confirmed tools/git-evidence.mjs62/95 requires byte-exact realpath; caller supplied forward-slash path on Windows. Supervisor replyee13e1d6-aaf4-4660-9c06-578d17b0e04a directs stop with inconclusive report, no working-tree substitute. Realpaths C:\0-BackupVF\WorkSpace\agent-depot and C:\Program Files\Git\ucrt64\bin\git.exe. Correct brief C:/0-BackupVF/WorkSpace/agent-depot/.isswf/initiatives/I0017/jobs/J002/review-brief-r1.md. No second launch, product diff empty.
- Direct continuation confirmed: operator coordinador encargate. REDfe79f6e/GREENba78a99 and precedence RED93768c0/GREENabdfe11, focused177/177 passing, typecheck/lint/build passed. Broader runs preserve2EPERM privilege failures and2frame-timeout failures (plus initial CLI prefix regression now fixed); complete local suite/CI not claimed green. Changes14files202+/22-, no real Host changes.
- One bounded functional correction; native private Markdown brief, not legacy checkpoint or renewed I0016 budget. Commit/push/PR default to origin iseoane/agent-depot main; no integration/release or user state operations. Preserve unrelated untracked files.
- R4ed6ccab7-2e93-431e-9444-7f00b4baebda complete/native terminal notice received; full report consumed, both axesPASS and R3-01resolved on36aa236. PR75 https://github.com/iseoane/agent-depot/pull/75 OPEN/non-draft base main/head36aa236 verified, body includes medium risk and local broader failures. CI41816410415 explicitly in_progress on exacthead; tracked/index clean. delivery.md retained private; no private untracked files committed. Firstpush server500 reconciled absentbranch/PR before one boundedretry succeeded; noforcepush.
- Round3 prep: preflight-review-r3.mjs andpreflight-review-r3.json retained with exact review-r3-bindings.json. Baseca22427->candidate01ff292 patch33309bytes SHA25652550351ce5457bc20e9dd14e1fd69ff195fda04bcc4764c988b4e40bb0ffaaf. All15changed files and20required guidance/consumer files accessible via bound content, eachbase/candidate. Exact-source/test delta fromabdfe11 absent; only docs/agents/workflows changed7+/1- after explicit user instruction. Static guidance check and diff-check pass.
- Initial research hypothesis rejected: host semantics mismatch and hidden commits, not stale-registry-only. Shared classifier and transient view consumers affected, therefore one shared host-aware policy; no persisted schema change.
- Worker30aa27a9-6cf9-4b8d-a3ab-100ad4c26e36 native terminal observed complete, semantic result blocked/not implemented; report C:/Users/iseoane/.pi/agent/sessions/--C--0-BackupVF-WorkSpace-agent-depot--/subagent-artifacts/outputs/30aa27a9-6cf9-4b8d-a3ab-100ad4c26e36/.isswf/initiatives/I0017/jobs/J002/implementation.md consumed. Resource reads self-reported, no selected-method application or RED/GREEN/test evidence. No replacement launched. Coordinator verifies HEAD remains ca2242730380788d49e36a35a8974420df5cbdb0, tracked diff empty and unrelated untracked files preserved.
