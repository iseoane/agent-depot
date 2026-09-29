# Uninstall Agent Depot

Ticket: `.scratch/agent-depot/issues/09-uninstall-agent-depot.md`

Objective: Offer independent removal choices for the persistent CLI, user-global managed Skills, and user-global catalog/configuration data. Preserve Skills and data by default. Never touch project installations or manifests (user-confirmed scope). Delegate CLI lifecycle to its package manager; do not self-delete or infer the manager. Retained Skills become untracked if state is removed. Cache is retained unless explicitly documented otherwise.

TDD: not configured; ordinary functional checks via `pnpm test`, `pnpm typecheck`, `pnpm lint`. Delivery: ask-on-risk; forecast ~250-400 authored lines. Branch from main before work-unit commits.

- [x] U1 Implement safe user-global uninstall choices, previews, and reconciliation of retained state. Route: delegated writer (multiple non-trivial files). Checks: CLI 45/45, sources 21/21, typecheck passed; partial-purge regression verified. Commit: pending.
- [ ] U2 Document usage and package-manager handoff; verify full suite and review scope. README updated with U1. Route: delegated verifier. Checks: typecheck passed; full suite 145/145; lint failed on 23 existing errors outside new hunks. Next: finalize evidence and commit.

Next: finalize checks and commit. Review found partial-purge record inconsistency and writer fixed it; independent full-suite check preceded that fix, focused test and typecheck passed afterward.
