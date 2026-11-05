# I0020: Fix duplicated Skills and ghost Packages in Catalog

Type: bug

## J001
- Status: completed
- Objective: Stop Catalog from multiplying Package rows on expand/collapse and from listing the same Skill once per foreign-host mirror directory.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Ships with the next release.

### Acceptance
- Non-installable Package descriptors are not shown in Catalog; their warning stays available in Source diagnostics. They never reserve Skills.
- Catalog node ids are unique even if two descriptors share coordinates (defensive: `bundleKey` plus a disambiguator, or dedupe in core discovery). Regression test: two descriptors with identical coordinates, expand/collapse repeatedly, row count stable.
- Skill discovery ignores mirror directories of hosts Agent Depot does not manage (supported Hosts: Claude, Codex, Pi, OpenCode; e.g. `.cursor/`, `.gemini/`, `.kiro/`, `.trae*/`, `.devin/`, `.github/skills`, ...) and test fixture trees (`tests/**`), and collapses identical Skills (same name and content) to one candidate with a canonical path preference. Decide in core discovery (ADR 0006), not in the view; check docs/adr for existing discovery rules first.
- Different Skills that share a name but differ in content are still both shown, distinguishable.
- Focused regressions with a fixture Source; real-impeccable check: 18 candidates -> 1.

### Evidence
- Operator 2026-11-05: same Skill repeated in the impeccable Source; Packages multiply when expanding/collapsing.
- Coordinator read-only probe of cached impeccable Source (git:ec673bd7694d3a658bba5faa): discoverSkills returns 18 candidates, all named `impeccable` (and one `audit`), from `.agents/`, `.claude/`, `.cursor/`, `.devin/`, `.dsh/`, `.gemini/`, `.github/`, `.hermes/`, `.kiro/`, `.trae-cn/`, `.trae/`, `.veto/`, `cursor-plugin/`, `plugin/` and `tests/oracle/workspaces/ctx-pin/...`. packages.discover returns two Claude descriptors with identical coordinates {marketplaceRoot "", pluginName "impeccable"}: one installable (plugin/skills), one not installable ("no in-repo marketplace binding"). `bundleKey` (src/tui/catalog-tree.ts:34) yields the same id for both -> duplicate React key; ghost rows on expand/collapse are the expected Ink/React symptom (inferred, not reproduced on screen).
- Operator: only Claude, Codex, Pi and OpenCode matter; «si uno de los paquetes no es instalable ¿para que lo tenemos en cuenta?»; accepted: «ok a todo!!».
- Operator start: «ese orden me parece correcto! encargate coordinador!» (order I0020 -> I0021 -> I0022 -> I0019). Budget: 1 worker, 1 reviewer, 1 correction cycle. Existing operator grant: low-risk PR merges after review + green exact-head CI; medium/high asks operator.
- Worker round 1 PARTIAL: RED 0b71cf6, GREEN a7b5de9 (mirrors/test trees hidden, identical SKILL.md collapsed, non-installable Packages hidden, unique bundleKey via selectionKey). Impeccable probe 18 -> 3: `.agents/`, `.claude/`, `plugin/` variants have different host-adapted content. Worker proposed dropping managed-host dot-dir variants; coordinator advised against (plugin variant uses ${CLAUDE_SKILL_DIR}, broken on Pi/Codex). Full pnpm test 1130/1216 pass, 43 EPERM, 1 known flaky, 4 unverified at baseline (worker junction denied by classifier; not bypassed).
- Operator decision: option 1 «1» — keep all content-distinct variants but group same-name Skills of a Source into one expandable row "<name> (N variants)" listing each variant path. Acceptance "18 -> 1" amended to "one visible Skill row for impeccable (3 variants)". Correction cycle 1/1 sent to the same worker.
- Correction round: RED af0a281, GREEN 2e85251 (variants grouping in src/tui/catalog-tree.ts). Worker final report for this round not received by coordinator (only completion notices). Coordinator checks at 2e85251: build/typecheck/lint pass; skill-discovery, tui-catalog-labels/-packages/-view/-install/-apps, package-bundles 102/105 pass, 2 skipped, 1 known flaky timing test (passes alone). Real cached impeccable probe via buildTree: one row "impeccable (3 variants)" with .agents/, .claude/, plugin/ children.
- Independent review R1 (Agent-tool reviewer, opus medium, not bound): Spec FAIL on F1 blocking — collapse keyed on name + sha256(SKILL.md) only, but CONTEXT defines a Skill as the whole directory; same SKILL.md with different supporting files would silently collapse (remedy: digest all snapshot files under the Skill dir + regression). F2 consumer checks, F3 unused exports (fallow), F4-F7 info. Risk medium; low after F1 + F2.
- Coordinator ran F2 consumer tests at 2e85251: cli, tui-installations-view, user-global-skill-inventory, skill-install, profile*: 167 pass, 12 skipped, 0 fail.
- Blocker: correction budget 1/1 spent; F1 fix needs operator authorization for one more correction cycle.
- Operator authorized one more correction cycle for F1+F3: «si». Correction 2/2 sent to the same worker.
- Correction 2/2: RED f9fe02f (2 failing deepEqual: b/tool collapsed), GREEN ec54386 (whole-directory digest via readSkillTree for same name+SKILL.md candidates; F3 consts private). Coordinator at ec54386: build/typecheck/lint pass; skill-discovery, tui-catalog-labels/-view/-packages, package-bundles, cli, tui-installations-view, user-global-skill-inventory, skill-install: 197 pass, 0 fail, 14 skipped.
- Risk classified low (reviewer: "low once F1 fixed and F2 green"; both satisfied, coordinator-verified; no second review call). PR #80 https://github.com/iseoane/agent-depot/pull/80 opened at ec54386; merge under operator low-risk grant after green exact-head CI.
- CI 42067613177 on ec54386: check/windows/pack SUCCESS, audit SKIPPED. Merged with matching head into main as 7c69a0a2d8f07241d4711d1ae21020f9fbe0bf82 (PR #80 MERGED, origin/main verified). Initiative closed.
