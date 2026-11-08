# Job brief J001 / r1

## Authorization
Operator 2026-11-08 «si y atacala» (feature-to-PR; low-risk merge by coordinator per .isswf/project-setup.md). Checkout /home/iseoane/Work/agent-depot, branch fix/package-root-labels, base 8b34a1d. Sequential single writer.

## Objective
A Package at its Source root never renders as `.` / `<host> .` / `<name>@.` in user-facing text outside the CLI selection tokens.

## Scope
1. Profiles: src/profile-export.ts:74 (describeProfilePackage), :85 (describeProfileReplica package case), src/profile-import.ts:160 (classifyPackage `thing`). Use a root-aware spelling, reusing src/package-model.ts displayPackageCoordinates / displayPackageSelection (added in I0027) or an equivalent small helper there. Lines already say `from <source>`, so do not repeat the Source. Example target: `Package pi from https://example.test/demo-bundle (latest; saved selection)` or with the bundle name; root-level must not show `.`. Non-root keeps its path.
2. Package flow reasons: src/package-flow.ts:172, 381, 392, 421, 526, 815 use describeCoordinates in messages; switch to the root-aware display (these messages are shared by CLI and TUI; display-only change is authorized).
3. README.md Updates row (~line 523): mention that Enter (as well as →/←) opens/closes the "cannot be checked" line.

## Exclusions
- Do NOT change describeCoordinates itself, profile-export.ts:59-62 `--package` filter identities (must keep accepting the existing form), formatPackageSelection, packageSelectionMatches, package-cli.ts:416/433 diagnostic output, or any persisted state/format.
- No Windows-test work (I0026).

## Acceptance
- Profile export/import previews (CLI and TUI) and Package flow reasons show no `.` root for Source-root Packages; non-root paths unchanged.
- `--package` filters for profiles still accept the previous spelling (existing tests stay green).
- Tests updated/added; tests/e2e-profile.test.ts:89 updated to the new spelling.
- pnpm build, typecheck, lint, test, test:e2e, audit:all pass; Linux and Windows CI green.

## Skills and evidence
- isswf-tdd: /home/iseoane/.claude/plugins/cache/isswf/isswf/1.6.1/.agents/skills/isswf-tdd/SKILL.md and .agents/roles/references/tdd.md under that root. RED test-only commit (SHA, command, failing assertion) then GREEN. README change: declared no-RED (docs).
- Comments: why, not what. Report resources consumed/missing.
