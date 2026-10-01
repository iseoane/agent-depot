# 05: App updates via CLI

**What to build:**
- Resolve each App's latest version from `latest`: the GitHub Releases API, the npm registry, or an argv with a pattern.
- `agent-depot app update <name>` runs the recipe's update step.
- Apps appear in `update check` and `update apply` alongside skills.

**Blocked by:** 03.

**Status:** completed

- [x] When `latest` is missing or unresolvable, the status is unknown and the App is not offered as an update.
- [x] `update apply` selects Apps together with skills, and one App's failure does not stop the others.
- [x] After an update, `version` confirms the new installed version.
- [x] Tests stub the GitHub and npm responses.


## Comments

Implemented on `feat/app-updates` in two feature work units:
- `2722791`: latest-version lookup and delegated update lifecycle, with core tests and spec/ADR decisions.
- `83329a6`: App selection in the existing CLI update batch, with CLI tests and README/help updates.
- Follow-up review correction: safe shell quoting for manual completion guidance, single version inspection in App listing, and unknown status for latest executable-resolution errors.

Verification: `pnpm typecheck` and `pnpm lint` pass; `pnpm test` passes all 572 tests. Focused suites: App updates (10), App lifecycle (13), App CLI (9), main CLI (70), CLI options (5). GitHub/npm use stubbed Responses; timeout/body errors never access the real network. Runtime harness: the CLI seam exercises a real built-in Skill and an App in one user-global batch, and an App failure followed by successful execution of the next App.

Review: fixed baseline `3d7be67e127db3d148ed39260b2b9a6f777da9f3`, assessed separately against repository standards and this ticket/spec/ADR. No remaining findings on either axis. Sub-agent tools are unavailable in this harness, so these are manual two-axis reviews, not independent parallel reviews.

Rollback boundaries: the first work unit removes latest lookup and App update lifecycle support; the second removes App participation in CLI update checks/selections/results while preserving existing Source/Skill runners and behavior. No branches were switched, no push or PR was made.
