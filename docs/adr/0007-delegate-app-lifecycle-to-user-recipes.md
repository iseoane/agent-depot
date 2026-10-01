# Delegate App lifecycle to user-declared recipes

Status: Accepted (2026-10-01)

## Context

Applications such as Engram, CodeGraph, and GitNexus are not portable skills. Their install channels and Host wiring differ, and their commands can create skills, MCP entries, plugins, hooks, or instruction blocks. Owning those artifacts would require Agent Depot to replicate each application's setup and recovery logic.

## Decision

Promote App to a supported, user-global resource category alongside Skill. Delegate install, update, uninstall, and optional per-Host setup and teardown to commands in user-declared App recipes. Preview and confirm lifecycle steps; approve recipe content before running any recipe command. Use the recipe's version command to determine installed state.

Agent Depot does not track, snapshot, or verify what an App writes, edit Host configuration on its behalf, clone App repositories, or ship built-in recipes. Recipes are user-owned files, not Source resources. The App's own commands own its artifacts.

## Consequences

- Users must supply recipes matching their actual install channel; Agent Depot does not provide an App catalog or infer artifact ownership.
- Agent Depot tracks App identity and installed version, not filesystem provenance or rollback of App-created artifacts. A successful version check does not prove Host wiring is correct.
- Declared owned-skill names/globs only exclude skills from unmanaged adoption/removal; they do not verify those paths.
- CLI and TUI use shared core flows, and Apps join existing Installations and Updates views. Project-scoped Apps and per-project steps remain out of scope.
- Recipe-directory placement, exact CLI grammar, approval mechanism details, and teardown-before-uninstall behavior remain open in `.scratch/apps/spec.md`.
