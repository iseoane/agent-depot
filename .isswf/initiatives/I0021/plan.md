# I0021: Group App recipes by platform and Skills in Catalog

Type: improvement

## J001
- Status: completed
- Objective: Show one row per App with the platform that applies on this machine first and other platforms as secondary info; give Catalog Sources a collapsible "Skills (N)" group.
- Depends on: I0020 (merged 7c69a0a)
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Follow-ups tracked in I0023.

### Acceptance
- Installations and Catalog Apps: one row per App name, e.g. `codegraph   windows ✓ approved    linux (other platform)`; status of the applicable recipe shown; recipe file paths hidden from list rows.
- Enter/detail shows each platform recipe with status and file path, marking which is used here.
- Same data on Linux shows linux first (platform-driven, no hard-coding).
- Actions (approve/install/uninstall) target the applicable recipe; non-applicable recipes remain removable/viewable via detail. No change to recipe files or approval semantics.
- Catalog Source node: `Packages (N)` and `Skills (N)` groups, both collapsible; filtering still opens matching groups.
- Focused TUI tests with fixture recipes for two platforms; Catalog tree tests updated.

### Evidence
- Operator 2026-11-05 screenshot: codegraph/engram each listed twice with full paths (`codegraph.windows.json` approved; `profile-<sha>-<uuid>.json` not applicable here). Operator: path «no aporta nada mas que emborronar».
- Coordinator mock-up accepted by operator («ok a todo!!»): grouped rows with platform badges, paths only in detail.
- Linux recipes came from a Profile import (`src/profile-import.ts` writeRecipe naming).
- Operator start: «ese orden me parece correcto! encargate coordinador!»; low-risk merge grant reiterated «si es riego bajo integrala tienes mi autorizacin». Budget: 1 worker, 1 reviewer, 1 correction cycle.
- Worker round 1 PARTIAL: Catalog `Skills (N)` group done (RED 2342a88 -> GREEN a6ba6f1, RED observed by worker: 3/3 behavioural failures). App grouping stopped: worker found the operator's screenshot is the Sources view recipe list (src/tui/sources-view.tsx:350-365 renders entry.file + status), not Installations/Catalog (both already filter `applicable`: src/tui/installations.ts:166, src/tui/catalog-state.ts:129). Coordinator verified; brief r1 pointed at the wrong surface (coordinator error).
- Scope correction (coordinator, matches the operator's request and screenshot): App platform grouping applies to the Sources view recipe rows. Installations/Catalog unchanged. Correction cycle 1/1 sent to the same worker.
- Correction 1/1: RED 7c1d01d (5/6 behavioural failures, worker-observed), GREEN 663a98f (Sources view grouping, per-file removal picker). Coordinator at 663a98f: build/typecheck/lint pass; tui-sources-*, tui-catalog-*, tui-app*, tui-retention: 171 pass, 2 fail (known EPERM 'marks a skill that has an unmanaged copy…', known flaky 'Catalog reload … keeps counting'). Review dispatched.
- Independent review R1 (Agent-tool reviewer, opus medium, not bound): Standards PASS, Spec PASS, risk LOW. Removal safety verified (picker index maps to rendered list; core re-checks hash/path; stale fails closed). Follow-ups: S1 pre-existing — non-applicable recipe cannot be removed while an App of the same name is tracked (src/app-recipe-removal.ts:46,55,75 matches tracking by name only; contradicts ADR 0007 "stays removable"; likely operator's codegraph case); S2 clashing duplicate rows indistinguishable without paths; S3 row omits primary platform when none applies; I2 unused export recipeMemberLine; I4 mock-up "✓" not used, stale e2e comment line 341.
- PR #81 https://github.com/iseoane/agent-depot/pull/81 opened at 663a98f; merge under operator low-risk grant after green exact-head CI.
- CI 42076237828 on 663a98f: check/windows/pack SUCCESS, audit SKIPPED. Merged with matching head (PR #81). Initiative closed.
