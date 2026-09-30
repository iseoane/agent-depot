# Project-scope uninstall is out of scope

Status: Accepted (2026-09-30)

## Context

User-global installations are recorded in the state file and can be checked before removal. Project installations live in a repository manifest and project files that Agent Depot does not own as fully, so removing them safely needs a separate design.

## Decision

Removal (`skill remove`, `uninstall`, and the TUI) handles user-global installations only, by user decision. Project installations can be installed and updated, and the TUI shows them, but `u` on a project row reports that project uninstall is not supported.

## Consequences

- No command reads or changes project manifests to remove skills.
- Revisit with its own ADR if project uninstall is wanted.
