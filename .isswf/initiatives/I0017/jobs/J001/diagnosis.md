# isSWF Package same-version updates: diagnosis

## Outcome
Read-only investigation complete. Agent Depot uses Git ancestry update eligibility for both hosts, but Claude's documented update mechanism is keyed by computed plugin version. With explicit1.6.1 unchanged, Claude keeps its cached plugin even after marketplace advances. Agent Depot offers a commit-based update that the normal Claude operation cannot install and then correctly refuses to record nonexistent progress. Pi can advance a Git checkout under the same manifest version. UI hides commits in results and mixes stored commit/available manifest labels.

## Current evidence (no host commands or refresh run)
- Agent Depot Source git:650c0e04252244b05c456352 cached HEAD: e2d3421157ec083d8a03e684c718285415574f0c.
- Pi actual checkout HEAD and Agent Depot verified/lastDelegatedCommit: e2d3421157ec083d8a03e684c718285415574f0c; package.json1.6.1. Record verifiedAt2026-11-04T07:36:43.992Z. Pi commit BEFORE screenshot operation unknown.
- Claude marketplace HEAD: e2d3421157ec083d8a03e684c718285415574f0c; lastUpdated2026-11-04T07:36:19.169Z.
- Claude registry installed_plugins.json: isswf@isswf, scope user, version1.6.1, gitCommitSha ce89f5ace1215b545c497369cfdc44074bbabbe5; installedAt and lastUpdated2026-11-03T19:11:35.698Z. installPath~/.claude/plugins/cache/isswf/isswf/1.6.1. Agent Depot Claude record verified/lastDelegatedCommit same ce89f5a, verifiedAt2026-11-03T19:11:36.803Z.
- Both cached plugin and marketplace .claude-plugin/plugin.json declare1.6.1; marketplace entry name isswf, source ./, no entry version.
- Source cache merge-base --is-ancestor ce89f5a HEAD succeeds. Git log/diff on Pi checkout establishes newer commit contains real changes:32 files,897 insertions,124 deletions, including tools/reviewer-task.mjs and planner-task.mjs, not merely unrelated repository-only metadata.
- Installed Claude vs marketplace reviewer SHA256: f7981578a808c4b9e0a46769c68c81e5a95ebad85c34c8c18c6181c0527ff633 vs3fdf0d7cde8006974dcf53962ed62b1f586358bca49fa692e2b7829f5cec1e32; planner1221e67112b637738082b9402564172eda8a2bd949e6b2966825405718631776 vs63c0d108caea54024dc46332a60ac080866ae60aaaf41ca3b8394e27b4fbc319. Pi matches marketplace both files. Thus stale installed content exists, not just stale registry metadata.

## Causal source trace
1. src/package-flow.ts288+ derives Source snapshot and actual host evidence; computes ancestor relation.
2. src/package-host-plans.ts216 classifyUpdate prioritizes installed commit over semver for every host. Same1.6.1 with ce89f5a ancestor of e2d3421 => update available, regardless Claude host's version-based cache.
3. Claude update template src/package-host-plans.ts80-81 runs marketplace update isswf then plugin update isswf@isswf. Current metadata matches marketplace refreshed/plugin untouched; historical stdout not retained, commands not replayed during investigation.
4. Official Claude docs https://code.claude.com/docs/en/plugins/loading#versions-and-updates: plugin update computes version and does not replace cached copy when matching installed_plugins.json. Manifest version wins; same string retains cached copy despite pushed commits. Docs https://code.claude.com/docs/en/plugins/host-marketplace: bump version for new copy or omit both manifest/entry version for commit tracking. Context7/web direct read corroborated.
5. src/package-flow.ts365+ recordOutcome update compares actual commit changes before writing selection; unchanged => failure, record untouched. Correct safety verification but misleading failure cause, after incorrect host-independent offer.
6. src/tui/package-rows.ts installedEvidenceLabel returns version before commit. src/tui/updates.ts473 and src/tui/package-actions.tsx122 use it for previous/verified, yielding1.6.1->1.6.1 for a real commit advance. updates.ts272 installed is recordedVersionLabel(check.installed), available uses manifest, so ce89f5a->1.6.1 mixes evidence types rather than comparing versions consistently.

## Verification
Executed pure dist/src/package-host-plans.js classifier with actual observed inputs and proven ancestry: Claude => update available, Pi matching HEAD => current; equal manifest without installed commit => current. No state-writing tests, host update CLI, Git fetch/refresh, product edits, configuration changes, reinstall, privilege changes or remote writes. Product Git status unchanged apart from new private I0017 records; preserved I0016/.pi/.scratch/package-lock.json.

## Conclusions and limitations
- Claude offer is not an executable upgrade under its current version contract, even though newer source content really exists.
- isSWF must publish a changed plugin version to deliver versioned Claude updates normally (or deliberately adopt unversioned commit tracking, a separate policy decision). No source package change authorized here.
- Agent Depot needs host-aware eligibility: preserve Pi commit semantics; for versioned Claude do not blindly offer same-version commits as ordinary updates. May indicate newer source exists but publisher version unchanged instead of silently reporting all source current. Improve unchanged diagnostic, not weaken verification.
- UI should display version plus commit on both sides when commit comparison drives updates, distinguish remembered from actual evidence.
- Current Pi is latest snapshot commit; screenshot success is consistent with legitimate same-semver Git advancement, but prior exact commit cannot be reconstructed from current records. Do not claim ce89f5a was Pi's prior commit.
- No historical command replay, running-Claude runtime verification, independent review, implementation or new release performed. Fix design/tests/review require next authorized bounded unit.
