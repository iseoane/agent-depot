# I0016: Recover missing managed Skill installations

Type: bug

## J001
- Status: completed
- Objective: Diagnose the Catalog/Installations deadlock for absent canonical Skill directories and propose safe recovery.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: Implement J002 after source-diagnosis reconciliation.

### Acceptance
- Trace Catalog hiding, Host exposure, uninstall and update preview against the reported missing paths.
- Identify safe recovery design and regression tests without touching real user state.

### Evidence
- Operator reports three builtin skills recorded for Pi, canonical paths absent in PowerShell, hidden from Catalog, and blocked removal/add-Claude.
- Base: 4f535c8274a36bd7f2c3315db6e102f10b1c995b (coordinator verified after diagnosis).
- Researcher b945a193-b420-452b-8a8a-20f36e6e51ab completed; source-only causal explanation, actual user state not inspected, no tests run. Report retained in native run output. Scope reconciled: shared persisted-record recovery, not Windows permissions or Catalog-only fix. Choose record-only removal with explicit preview and fail-closed exposure; independently review state-loss safety.

## J002
- Status: completed
- Objective: Allow confirmed record-only removal for safely verified absent global Skill installations through shared CLI/TUI flow.
- Depends on: J001
- Brief: [brief-r1.md](jobs/J002/brief-r1.md)
- Blocker: None for delivered0.6.7; historical review procedural limitation retained and explicitly excepted for release; later full CI passed.
- Next step: Preserve recovery/review evidence. Real record cleanup and subsequent J003 Claude installs already verified; installed CLI upgrade remains separate.

### Acceptance
- Explicit no-files-removed preview; unchanged absence/records rechecked before record-only recovery.
- Unsafe ancestors, Claude leftovers, overlaps and reappearance fail closed; no real user state touched.
- Focused isolated regression tests and project checks; preserve normal removal/host behavior.

### Evidence
- Feature branch fix/missing-managed-skill-recovery created at verified base. One writer only; unrelated untracked files preserved.
- Worker d89c0496-cb1c-4922-b529-f41e73be2874 completed, 7 files changed. Source patch snapshot candidate.patch SHA256 e3fd00614afb0a50eb2508a2b10c70c0b0058affb8f31771a783aed4aaaa649f.
- Worker reports typecheck/lint/build and 5 focused CLI tests pass. Full pnpm test failed with Windows symlink EPERM and TUI timeouts; pre-existing status not established, no full-suite pass claimed. Coordinator diff --check passed.
- Independent reviewer 7c3ba883-da1d-4399-b9d7-fc2a21da446e returned Standards fail / Spec fail: later batch classification change detected after earlier mutation; false adopted-deletion warning and incomplete all-host/bulk completion messages; missing required edge/UI/reload regressions. Adverse evidence retained in native output; candidate not accepted.
- Correction 1 authorized within original acceptance and 2-cycle ceiling; scope in jobs/J002/correction-1.md. Original worker terminal observed with native resume eligibility. No new acceptance revision, actor replacement or budget reset.
- Correction run 52006a76-9f7e-4edd-8a68-a1211785a407 completed; worker reports batch-wide precheck, truthful messages and added safety/UI/reload/reinstall tests. Typecheck/lint/build pass, focused 8 core + 10 CLI + 3 TUI tests pass (worker observations). No full-suite rerun or green claim.
- Coordinator snapshot candidate-c1.patch SHA256 4e9c1daa54c47ff940b9f099069149cea1391e8683451534f3599436a806eb3a; 11 files, 534 insertions/36 deletions, diff --check passes. Original rejected patch preserved. Read-only re-review, no active writer.
- Re-review 6c8d96d6-657f-421c-8aa6-4ebd8d273a65 completed Standards fail / Spec fail. Original batch and messaging defects closed; Source-removal consumer can forget a changed record because src/cli.ts runSourceRemoval omits managed-record snapshot comparison before removeGitSource. Requires isolated changed-record/new-alias regressions. Source report native output review.6c8d96d6.md retained. No acceptance or user-state changes.
- Budget: researcher 1, worker initial + correction 1, independent reviews 2/2 consumed. Correction 2 within project ceiling remains, but no further independent round granted; operator subsequently explicitly authorized correction 2 and one additional scoped independent review with “si”. No further automatic rounds; current grant documented in correction-2.md.
- Final correction run 1ce8d127-c248-47f3-bfed-507d42926d30 completed. Worker reports Source-removal snapshots before file mutation and at persistence, plus absent-target revalidation. Typecheck/lint/build and 3 source CLI + 1 checklist TUI + 8 core tests pass. Full suite not rerun/unvalidated.
- Coordinator candidate-c2.patch SHA256 e70ba9f535836d0be8178a09d57694cb07558f708e3c17e8b74404d3dab7a288; diff --check passes, frozen uncommitted candidate. Earlier rejected snapshots preserved.
- Final reviewer run 5cd5cb23-473a-4223-9bd2-bcc3270a0045 completed: Spec pass, Standards inconclusive (procedural missing external code-review skill), aggregate inconclusive. Source-removal blocker closed, no new substantive delta finding. Full review in retained native output review.6c8d96d6.5cd5cb23.md. Coordinator independently read workflows.md trigger and searched user skill roots without finding code-review; no substitute installed or procedure waived.
- Coordinator rechecked patch SHA256 unchanged and diff --check passes. No candidate acceptance, commits, publication, installed CLI replacement or actual user-state recovery performed. Final writing cycle and additional review spent.
- Operator answered “ok” to controlled local recovery proposal with explicit preview-before-confirmation. Coordinator pnpm build passed, then node dist/src/cli.js skill remove agent-depot-apprecipe doctor-md-agents doctor-md-skill (NO --yes) confirmed all three are record-only/no-files-removed. Command refused mutation with expected “Removal not confirmed”; no retirement applied. Operator subsequently explicitly confirmed “si”. Coordinator executed same local CLI with --yes: “Forgot 3 missing user-global Skill installation records; no files were removed”. Independent subsequent CLI lookups for each name report Unknown user-global Skill; discover builtin:agent-depot lists all three as candidates. Recovery of stale records complete; no fresh installations performed, no installed CLI replacement. Catalog UI visual verification remains operator-side.
- pi-subagents 0.83.0 loaded on Pi 1.5.0; roles discovered; researcher model openai/gpt-6-luna high verified via models action. No other writer dispatched by this coordinator.

## J003
- Status: completed
- Objective: Expose Claude Skills through managed directory junctions on Windows without elevation, preserving POSIX links and safety.
- Depends on: J001
- Brief: [brief-r1.md](jobs/J003/brief-r1.md)
- Blocker: None for delivered0.6.7 under explicit procedural exception; Linux/Windows full release CI later passed. Discovery within running Claude remains unobserved and is not claimed.
- Next step: Operator reopen Claude to verify discovery and separately update global CLI if desired; preserve actual junction-install evidence.

### Acceptance
- Shared creation uses absolute-target Windows junctions, POSIX relative directory symlinks unchanged.
- Recognition, foreign-target refusal, removal, update/overwrite/rollback preserve canonical content and ownership safeguards.
- Native Windows sandbox tests, affected checks, minimal domain/ADR docs aligned.

### Evidence
- Operator explicitly says adelante after GitHub isSWF PR172/112 precedent verified. New unit budget worker 1, independent review up to 2, correction at most 1; no retries/replacement, J002 exhausted budgets unchanged.
- Starting preserved uncommitted J002 c2 patch e70ba9f535836d0be8178a09d57694cb07558f708e3c17e8b74404d3dab7a288 on Git base 4f535c8274a36bd7f2c3315db6e102f10b1c995b. Sole writer, no worktree/remote/privilege/global-state changes.
- Source has fresh/additional/overwrite directory-link creation sites and filesystem interface limited to dir; trace readers/removers. Native proof initially pending.
- Worker cd7faffd-598c-4850-aea7-0bf7ef259464 completed. Reports shared junction creator and single-entry rollback unlink; sandbox native junction create/readlink/repeat/partial removal/rollback, affected suites 85 passed/13 skipped/0 failed (98 tests), typecheck/lint/build pass. Linux and installed Claude discovery untested, symlink-ancestor fixtures skipped, no real-state access.
- Coordinator snapshot J003/candidate.patch SHA256 5c67e903a98a81617ff4fafce5b93251b99688b31a10166b0e6aa2670c618d5a, diff --check pass. Prior J002 snapshot unchanged. No active writer at snapshot.
- Reviewer 5dbc7366-1f83-4b88-99cd-0bbb43a5750f returned Standards/Spec/aggregate inconclusive: no demonstrated additive production defect, but native junction-ancestor refusal and overwrite-created junction+rollback evidence absent; supporting code-review missing remains procedural blocker. Reports distinguish full-removal recursive rm baseline as not newly certified or newly defective.
- Correction 1 within existing J003 grant selected to close two original acceptance verification gaps; no scope/acceptance revision or budget reset. Instructions jobs/J003/correction-1.md. One affected re-review remains.
- Correction run 1772b2e3-1b04-4b02-a47d-81de4fa34787 completed: only tests/project-installation.test.ts changed, native Windows junction ancestor and Pi+Claude overwrite+rollback tests ran/pass. Worker final affected suites 100 total,87 pass,13 existing skips,0 fail; build/typecheck/lint pass. No production correction, no Linux/Claude installed discovery validation.
- Coordinator candidate-c1.patch SHA256 1e22386e4be015f859670052f09240c61875e9cddd29172a4fd658395275d0f9, diff --check pass; original snapshots preserved, checkout frozen. Final reviewer 91102dbe-957d-47c8-b7f8-bbd371a51b4a completed: Spec pass, both native gaps closed, no further implementation finding; Standards/aggregate inconclusive solely procedural missing supporting skill. Native inventory-specific ancestry, installed Claude discovery, Linux/macOS and full suite unverified; full-removal baseline recursive rm not newly certified. Full report retained as native output review.91102dbe.md. Only worker initial+one correction and two reviews consumed; no further rounds or real-state changes.
- Operator accepted limits and authorized controlled preview with si. Coordinator ran three local install commands WITHOUT --yes (user-global,builtin:agent-depot,host claude,latest,portable-v1). All three canonical targets absent; previews confirm zero files/state changed and stop Installation not confirmed. Await post-preview explicit confirmation. Preview retains generic symlink wording, actual Windows creation implementation uses junction; no claim preview wording fully updated.
- Operator explicitly confirmed si AFTER actual three previews. Coordinator installed exactly the three named builtin skills for Claude via local CLI --yes; all exit0 and shared Source installation state saved. No privileges/config changes or global CLI replacement.
- Coordinator independently verified each actual ~/.claude/skills/<name> alias via lstat/readlink/realpath plus reading SKILL.md: link-classified, absolute canonical target, realpath matches ~/.agents/skills/<name>, readable content. All three pass. This proves actual filesystem exposure, not yet discovery inside running Claude. No code commits/publication.

## J004
- Status: completed
- Objective: Prepare and deliver patch release 0.6.7 containing I0016 recovery and Windows junction fixes through existing release workflow.
- Depends on: J002, J003
- Brief: [brief-r1.md](jobs/J004/brief-r1.md)
- Blocker: None for published0.6.7; historical procedural review inconclusive retained with explicit release-scoped operator exception.
- Next step: Operator may update installed CLI separately. Preserve local detailed records/snapshots and unrelated untracked files; no automatic global install.

### Acceptance
- Patch metadata/changelog and release notes consistent; preserve unrelated files and prior evidence.
- Resolve procedural review gate and pass exact-head CI plus normal publish workflow checks before npm/tag/GitHub release.

### Evidence
- Operator explicitly requested genera release patch. Latest GitHub release v0.6.6; package/changelog prepared for0.6.7.
- Coordinator typecheck/lint/build pass; release-artifact/release-notes tests9/9 pass with scoped native Windows tar PATH; version tests8/8 pass; diff --check pass. Initial GNU tar C: remote interpretation failure retained, no global PATH change.
- No commits/PR/push/tag/npm publish/GitHub release yet. Release workflow main-only and all checks retained.
- Operator explicitly granted missing supporting code-review exception for0.6.7 with si; all CI/publish checks remain mandatory. Current remote main matches local base4f535c8274a36bd7f2c3315db6e102f10b1c995b, no existing feature PR. Loaded chained-pr hard limit400; no cached chain strategy or size exception. One cohesive slicing assessment: core recovery, CLI recovery, TUI recovery, junctions, release metadata can form ordered slices, but original already-reviewed combined candidate exceeds limit. Operator explicitly authorized single PR size:exception with si!. Coordinator committed19 authorized files6b3bfad, excludes .pi/.scratch/package-lock/raw records; published PR74. First CI41774717071 Linux failed one stale cli-progress expectation for new revalidation step; pack passed. Coordinator mechanically updated only expected label, local progress suite17/17 pass, commit f9388db pushed. Fresh exact-head checks pending. Changelog date corrected to current2026-11-04. Windows CI then found one outdated relative-target assertion in cli-skill-hosts; coordinator asserted absolute-on-Windows plus canonical target equality, local1/1 pass, commit1b39b81.
- Final exact-head CI41775609222 on1b39b8173c10233c6f885cdb6bc579d532784afe PASS Linux(full/E2E/release tests),Windows full,pack; PR audit skips by pre-existing workflow policy. PR74 merged with expected-head guard via merge commit ca2242730380788d49e36a35a8974420df5cbdb0.
- Release workflow41776074571 on exact merge commit SUCCESS verify/publish/tag: full tests,E2E,dead-code,skills,pack,release artifacts/notes, npm latest/integrity verification, annotated tag and GitHub release. npm propagation ~4m30 handled by existing workflow, no duplicate publish.
- Coordinator independently read back npm version/latest0.6.7 and non-draft/non-prerelease GitHub Release https://github.com/iseoane/agent-depot/releases/tag/v0.6.7. Annotated tag e7cd5883ca6fbbb7fb64b06a3e27cbc45d2ca740 resolves to exact merge ca22427.
- Local main fast-forwarded to published merge. PR MERGED + ancestry + empty git cherry verified before deleting only merged feature branch locally/remotely under project cleanup policy. No worktree used; unrelated untracked .pi/.scratch/package-lock preserved. CLI globally installed not changed.
- Detailed local initiative records remain untracked/private because they include raw patches/machine-specific evidence; not swept into published candidate or new receipt-only main commit. Bounded public evidence retained in PR74, CI and immutable release. Any future publication of curated receipt must separately exclude raw/private records.
