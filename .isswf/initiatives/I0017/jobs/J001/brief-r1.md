# I0017 J001 readonly investigation

## Authorization and outcome
Operator explicitly says ok adelante con la investigacion. Coordinator investigates directly, no model dispatch or old budget reset. Scope read-only source/tests and minimally filtered real isSWF host/AgentDepot metadata and local Git history; GitHub read-only if needed. No source refresh/fetch, host CLI calls, updates/reinstalls, configuration changes, product edits, remote writes/issue creation or privilege changes. Local coordinator research records allowed. Goal explain screenshot isSWF Pi update1.6.1->1.6.1 OK, Claude unchanged1.6.1 fail, row ce89f5a->1.6.1, not fix automatically.

## Inputs and grounding
AgentDepot main ca2242730380788d49e36a35a8974420df5cbdb0 released0.6.7. Read domain and ADR0009, which explicitly says same manifest version cannot override clean Pi commit mismatch. Sources inspect uses installed commit/source ancestry. src/package-host-plans.ts:classifyUpdate prioritizes commits; src/package-flow.ts:installedEvidenceChange compares commits then versions; src/tui/package-rows.ts label hides commit if version present; src/tui/updates.ts package row uses stored verified label instead of host evidence. Trace deriveBundle/readHostView, cached source access and host argv for Claude marketplace update/plugin update. Do not run host commands.

## Checks/evidence and stopping point
Get installed isSWF Pi HEAD/version and Claude host-registry/marketplace/plugin-cache HEAD/version without reading unrelated settings or secrets. Compare available cached snapshot HEAD/version and ancestor relation, inspect diff paths for plugin-scope relevance. Determine whether Claude caches by version and records unchanged gitCommitSha despite marketplace newer; distinguish source inference from actual CLI behavior (no host update execution authorized). Check existing tests for same-version-different-commit and unchanged outcomes. If practical execute only pure classification functions no writes; state-writing tests not needed. Report paths, versions/commits, proven causal path, unknown prior Pi state, UI confusion and bounded recommendations. Stop at diagnosis, no implementation/PR/release.

## Quality
Correctness: source plus filtered actual evidence; no claims of historical reproduction. Safety/privacy: no auth/key/history files, report only package metadata. Determinism: snapshots timestamps and commits can change, use observed IDs. Maintainability: no product mutation. Coverage: inspect pure classifier and tests, not assume screenshot proves false update.
