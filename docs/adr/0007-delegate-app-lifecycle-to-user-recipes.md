# Delegate App lifecycle to user-declared recipes

Status: Accepted (2026-10-01)

## Context

Applications such as Engram, CodeGraph, and GitNexus are not portable skills. Their install channels and Host wiring differ, and their commands can create skills, MCP entries, plugins, hooks, or instruction blocks. Owning those artifacts would require Agent Depot to replicate each application's setup and recovery logic.

## Decision

Promote App to a supported, user-global resource category alongside Skill. Delegate install, update, uninstall, and optional per-Host setup and teardown to commands in user-declared App recipes. Preview and confirm lifecycle steps; approve recipe content before running any recipe command. Use the recipe's version command to determine installed state.

Agent Depot does not track, snapshot, or verify what an App writes, edit Host configuration on its behalf, clone App repositories, or ship built-in recipes. Recipes are user-owned files, not Source resources. The App's own commands own its artifacts.

Recipes live in `apps/` beside environment-local `sources.json`; private atomic approvals in sibling `app-approvals/` are keyed by canonical file path and exact content hash. CLI approval is only `app approve <name> --yes`, never validation. WSL manages Linux only and skips Windows drive PATH candidates.

## Consequences

- Users must supply recipes matching their actual install channel; Agent Depot does not provide an App catalog or infer artifact ownership.
- Agent Depot tracks App identity and installed version, not filesystem provenance or rollback of App-created artifacts. A successful version check does not prove Host wiring is correct.
- Declared owned-skill names/globs only exclude skills from unmanaged adoption/removal; they do not verify those paths.
- CLI and TUI use shared core flows, and Apps join existing Installations and Updates views. Project-scoped Apps and per-project steps remain out of scope.
- Update-selection CLI grammar and teardown-before-uninstall behavior remain open in `.scratch/apps/spec.md`; recipe placement, approval and WSL environment boundaries are resolved.

## Lifecycle implementation decisions (ticket 03)

Installed-App records live in sibling `app-installations/`, keyed by hashed App name and published using the existing atomic-file adapter. This keeps App state separate from the strict Source/Skill state schema and avoids shared read-modify-write updates. Records contain identity, canonical recipe path and verified installed version only.

Uninstall never implicitly runs Host teardown: teardown remains separately previewed and confirmed. The non-interactive CLI uses `--manual-done --yes` to attest manual completion, and `uninstall --forget --yes` to explicitly drop tracking without running commands.
