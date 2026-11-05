# I0018: Reduce local Source snapshot loading cost

Type: bug

## J001
- Status: completed
- Objective: Measure Sources, Catalog and Installations loading and distinguish network from local work.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None for diagnosis; actual Sources paint/overlapping work remains unexplained.
- Next step: Implement the authorized first shared-reader block in J002; no tab-retention cache yet.

### Acceptance
- Read-only probes, no Source refresh or real installation/configuration changes; attribute timings and limits accurately.
- Separate user-observed TUI latency from measured data loaders and potential causes.

### Evidence
- [Diagnosis](jobs/J001/diagnosis.md): Sources list4–16ms/recipes20–32ms; Catalog combined29.779s444processes416show; Installations24.583s237processes209show. Expensive samplesN1, no HTTPattempts underblockednetwork. User reports actual41sinitial/reentry, paint not independentlymeasured.
- Raw probes/results private under.scratch; no graph/installation/modelactor needed for diagnosis. Initial300processbudget perturbed standalonePackageinspection excluded; subsequentcompleteprobesvalid.

## J002
- Status: completed
- Objective: Reduce initial Catalog and Installations cost by bounded Git batch reads and reuse of immutable Source snapshots without weakening freshness or safety.
- Depends on: J001
- Brief: [brief-r2.md](jobs/J002/brief-r2.md) (explicit coordinator continuation; original worker attempt retained).
- Blocker: None. Operator explicitly «integra y saca release patch» authorizesintegration+patchrelease. ExactPR76headc7cedc6reviewPASS/CI41901664781SUCCESS rechecked; mergedwithmatchhead to main e9bac638e0925278f2cf5485cee0e75323c643a0, readbackMERGED/fetchedmainverified. Local full-suite adverse retained separately, remoteCIgreen doesnotrewriteitsresults.
- Next step: J003 authorizedpatch0.6.9 metadataPR77 andexistingpublishworkflow, no globaluserupdate/cleanup/additionalperformanceimplementation. Worker1/1, review1/2, correction0/1 remain cumulative. [Delivery](jobs/J002/delivery.md) retains originalreview/CI and [release record](jobs/J003/release-record.md) currentintegration/releaseprovenance.

### Acceptance
- Replace per-file Git snapshot subprocess loop with bounded batched reads while retaining selected immutable commit, safe scope/path/type exclusions, byte/protocol limits and failure semantics.
- Deduplicate repeated simultaneous snapshot work across real Skill/Package/ownership consumers, keyed by sufficient Source/cache/scope/commit identity and bounded lifetime/resources; no stale mutable Host/approval or destructive-action evidence.
- Regression tests for protocol/correctness/invalidation; selected TDD test-only behavioral RED then separate GREEN; isolated-env/temp state in tests.
- Correctness-checked before/after representative measurements with sample counts and spread, no invented performance budget or speedup claim from incomplete work.
- Source/test/docs cohesive review units, independent Standards/Spec judgment, required checks and PR exact-head CI; retain adverse evidence.

### Evidence
- Coordinator continuation explicitly authorized «por supuesto coordinador!», retained by «continua»/«avanzar todo lo que puedas»; no other worker. [Implementation](jobs/J002/implementation-coordinator.md) retains both real RED/GREEN pairs, final checks93reported85pass8existingplatformskip0fail and59TUI/59pass, full-suite adverse45fail+tooltimeout, and comparable performance provenance. Sixfiles253add38delete under400line strategy.
- Three comparable alternating pairs/loader on cdc6ad4 demonstrate Catalog median31.749s->2.369s450->27processes; Installations19.055s->1.885s241->30. Complete serialized output hashes equal every sample; HTTP blocked/noattempts. Finalcandidatec7cedc6 only pending-input EOF delta; exactSHAconfirmation2.424s/1.870s, samehashes/counts. These are loaders, NOT actual terminal paint. Currentinventory134Skills/17unmanaged; oldJ001N1timings not reused as comparablebaseline. Private artifacts remain under.scratch, no userrawdata staged.
- R1review8d8d104b-2f55-40ae-85bd-16f2a0df89e2 native terminalreport132lines fullyconsumed: StandardsPASS/SpecPASS/noblockers, complete requiredmethodology perreport. S1nonblockingpressurematiz acceptedbyqualifyingprivateapplicationmap/publicPR; no sourcechanges/newreview/correction. Sixfilesexactheadstillc7cedc6. Branchpushedwithoutforce andPR76published/readbackverified; no userinstallation/update/merge/release.
- [First review brief](jobs/J002/review-brief-r1.md), canonical36path allowlist and preflight prepared before call; REVIEW.md absent. Initial preflight caught nonexistent legacy src/source-content.ts context path; removed before launch, then all74opsPASS. No actor consumed by this local preparation error.
- Trusted current operator «si» answers explicit start question for batching+snapshotreuse, tests/measurements/independentreview/PR. Prior «ok» onlyproposal; no dispatch occurred then.
- Baseline2ec4b38058c87a03510c2d69424588535cc64399 fetchedverified origin/main; branchperf/source-snapshot-loading created, tracked/index clean, unrelateduntracked .isswf/.pi/.scratch/package-lock preserved. Sequential solecheckout, no worktreecreation.
- Finite grant: one worker total, at most two independent review calls total, one correction cycle total. No automatic retry/replacement/nesting; reviewerbudget is ceiling not requirement. Coordinator owns push/PR/CI againstorigin iseoane/agent-depot main; worker may scoped edit/tests/localcommits only. No integration/release even projectsetup has low-riskdefaults.
- Hostreadiness Pi1.5.0 pi-subagents0.83.0 registered+loaded, native agentlist discovers projectroles. Approved effective native worker openai/gpt-6-luna high; reviewer openai/gpt-6.1-sol medium from existinguseroverrides, preserved. Factoryroot C:/0-BackupVF/WorkSpace/isSWF, target distinctagent-depot. No model substitution/configinstall.
- Existing compiled/installed0.6.8 provides unchangedbaselineartifact for coordinator alternatedprobes; worker tests use fixtures only, no realHoststate/userrecipe access or lifecycleexecution. No nativeGitHubCIwake established, technicalwait mustremainhonest/no watchpoll loops.
- Native terminalcompletion a8285f0a-46c0-4b60-91cd-fde943b255e8 report fullyconsumed from retainedoutputs/a8285f0a.../.isswf/initiatives/I0018/jobs/J002/implementation.md: partial/notimplemented. Repeated exactedit failures triggered liveguidance to reconcile, then invalidtestfake unexpectedblob failure (notvalidbehavioralRED); worker restored own testexperiment. Coordinator readback HEADbaseline2ec4b38058c87a03510c2d69424588535cc64399 branchcorrect tracked/index clean. Onlybaselinebuildpass; no candidates/tests/performanceimprovement/review. Report recommendation freshattempt underoriginalbudget rejected: actorreportcannotrenew1/1budget. No replacementactor launched.

## J003
- Status: completed
- Objective: Publish authorized stable patch0.6.9 containing integrated performance fix.
- Depends on: J002
- Brief/record: [release-record.md](jobs/J003/release-record.md).
- Blocker: None. 0.6.9 publication verified 2026-11-05.
- Next step: None; follow-up measurement continues in J004.

## J004
- Status: completed
- Objective: Measure real TUI paint and keyboard responsiveness on installed 0.6.9 before choosing further optimizations (proposal E).
- Depends on: J003
- Blocker: None
- Next step: Operator chose C and a progress-focused D; scoped as J005.

### Acceptance
- Real PTY timings for cold open, cold/revisit Catalog and Installations, and Sources after abandoning an unfinished Catalog load; navigation only, no actions.

### Evidence
- Operator «ok / encargate» then chose option 1 (repair local node-pty). pnpm rebuild was a no-op; prebuild-install restored win32-x64 node-v147 binary from local npm cache into node_modules only. No tracked changes.
- Probe .scratch/measure-tui-paint.mjs, results .scratch/tui-paint-{1,2,3}.json; installed agent-depot 0.6.9, Node 26.12.1 win32, real user state, keys 1/2/3/q only. Ready = first frame with view marker and no loading label. N=3 (ms):
  - Cold open Sources: 4829 / 2109 / 1850.
  - Cold Catalog: 4469 / 4321 / 3793. Revisit Catalog: 3242 / 3108 / 2408.
  - Cold Installations: 3651 / 2188 / 2105. Revisit Installations: 2284 / 2211 / 2081.
  - Sources from another tab: 92-125. Sources after abandoning Catalog at 300 ms: 80-108 (no background-overlap penalty observed).
  - First output after any keypress: 6-18 ms (keyboard responsive).
- Conclusion: reported 41 s no longer reproduces; Sources slowness explained/absent. Remaining cost is full reload on revisit (~2-3 s). Marker heuristic, not frame-perfect paint tracing.

## J005
- Status: completed
- Objective: Keep view data across tab revisits (C) and make long Installations batch operations show what is running and how far along they are (operator-reported D).
- Depends on: J004
- Brief: [brief-r1.md](jobs/J005/brief-r1.md)
- Blocker: None
- Next step: None. Released only when the operator asks for a patch/minor release; cold-load re-measure on an idle machine remains optional.

### Acceptance
- Revisiting Catalog/Installations shows the last valid data immediately with an explicit stale/refreshing indicator, then swaps in fresh data; invalidated after Source refresh/add/remove, recipe/approval changes and any install/update/uninstall/host/adoption action. Mutation previews and confirmations always use fresh state. Never cache mutable Host/approval/deletion decisions as truth.
- Multi-item App/Package/Skill operations in Installations show the current item and position ("Running App step: <name> (2/5)…"), finished items so far, and the post-action refresh as its own labelled phase instead of one generic clock.
- Focused regressions (TUI/component level with injected operations): revisit shows cached data then refreshed data; invalidation after an action; batch progress labels per item; failure in one item keeps progress and remaining items.
- Re-measure with .scratch/measure-tui-paint.mjs (N=3) and compare with J004.

### Evidence
- Operator start: «si coordinador, vamos a hacer las tareas de I0018 y asi la cerramos!». Budget: 1 worker, 1 reviewer, 1 correction cycle; no merge/release.
- Operator integration grant (2026-11-05): «si la PR es de riesgo bajo integra directamente, no hace falta que me preguntes». Low-risk PR with independent review PASS and exact-head CI green may be merged without asking; medium/high risk still needs operator decision. No release implied.
- Worker round 1: RED aae02fd (test-only), GREEN a6fad0d; 13 files +531/-53. Coordinator observed RED in a detached worktree at aae02fd: 4/4 retention tests fail on expected assertions (retained catalog not shown, "Loading installations" present, generic App step label timeouts). Coordinator re-ran tui-retention/tui-retention-store/tui-batch at a6fad0d: 10/10 pass.
- Independent review R1 (Agent-tool reviewer, opus medium; NOT a bound claude -p review, identity tool unavailable): 0 blocking, S1-S4 suggestions (missing per-action invalidation test, bulk Skill progress test, weak revisit assertions, no full TUI run on exact head), I1-I3 info. Standards/Spec inconclusive; risk medium (borderline low), dropping to low with S1 + clean S4.
- Re-measure at a6fad0d with node dist/src/cli.js (N=3, .scratch/tui-paint-j005-{1,2,3}.json): revisit Catalog 11-33 ms (was 2408-3242), revisit Installations 31 ms (was 2081-2284). Cold numbers (Catalog 5.9-8.6 s, Installations 3.5-4.8 s) are contaminated by a concurrent worktree build; re-measure on idle machine before comparing cold loads.
- Correction cycle 1/1 sent to the same worker for S1-S3 tests plus full tui-* run on final head.
- Operator explicit integration decision (2026-11-05): «abre la PR e integrala». Covers this J005 PR regardless of medium risk; merge after exact-head CI green. No release implied.
- PR #79 https://github.com/iseoane/agent-depot/pull/79 opened at 04dfcd7 (correction commit: tests only). CI 42033329397: windows/pack SUCCESS, Linux check FAILURE in e2e "a slow App install shows an advancing spinner…" (regex expected old generic "Running App step…"; label intentionally changed). Coordinator direct mechanical test-only fix bb4d594 (regex now "App step: fixture-app…"); test is skipped on Windows so not locally verifiable; correction budget was 1/1 spent, recorded as coordinator fix of a CI-observed stale expectation, no production change. New CI 42033965759 on bb4d594: check/windows/pack SUCCESS, audit SKIPPED per workflow. Merged with matching head bb4d594 into main as 8de09e1eb373cfe9f6fcdc03f057f02f16133ab7 (PR #79 MERGED, origin/main verified).
- Operator: «la idea del installations a mi no me parece mala, si lo pruebas veras que si pides varios se queda mucho rato corriendo el reloj sin mas...» and «y el tema del conservar los datos si!».
- Coordinator source check (not reproduced live; would mutate real state): src/tui/app-actions.tsx prepareNext/execute process marked Apps sequentially with generic labels "Preparing App step…"/"Running App step…" (no item name or count); child process output is not shown; after the batch, manage.finish → refresh() shows "Refreshing installations…" and reloads everything (~2 s per J004). src/tui/installations-view.tsx reload() has no retained data across remounts (views unmount on tab change, src/tui/app.tsx).

## Remaining proposals — disposition (2026-11-05)
The completed first block is diagnosisA+B: batched Source reads and bounded immutable shared snapshots. Do not present backend timings as terminalpaint or wholeinitiativecomplete.

1. **Measure real TUI after0.6.9 first (E, recommended next).** Separate firstcompleteframe/keyboard responsiveness fromloadercompletion; coldopen, revisit and leaveunfinishedCatalog->Sources. Sourcesown reads were4–32ms inJ001; perceivedslowness/backgroundoverlapstillunproven. Remeasurebeforechoosinganothercache.
2. **Tab revisit/readmodel retention (C, conditional).** Preserve lastdisplaydata/selection whereuseful, with explicit loading/stale/error and invalidation after Sources/recipes/Host lifecycle changes. Currentimmutableblobcachealreadyhelpsremount, so measure residualbenefit beforeaddUIcache. Never reusecachedmutableHost/approval/deletion decisions.
3. **Progressive Installations groups (D, conditional).** IfslowApp/Packagechecks stillblockusefuldata, renderreadygroups independently with deterministicordering/per-groupwarnings, pendingstatus explicit and freshdestructive-actionchecks. Profilebeforeparallelizing; no automaticnewdependencies.
4. **Many-Sources cache-pressure control (R1/S1, optional lowpriority).** Coalescingbest-effort within8indexedkeys; pressuretest>8pendingSourcekeys canquantifyduplicatework. Strongerpendingregistry onlyifrepresentativeworkloadjustifiesnewresourcepolicy; no demonstratedcorrectness/freshnessdefect.

Disposition: E done (J004); C done (J005); D delivered as per-item batch progress (J005), progressive group rendering not needed by J004 data; R1/S1 not justified by data, dropped. Initiative closed.

These are retained proposals, not new model/worker/correction budgets or approval to implement. Userquestion askswhatremains; currentexecutiongrant is integration+patchrelease. Prefer actualpostpatchUImeasurement beforeC/D; no inventedlatencytarget or GitHub/TypeScriptblame.
