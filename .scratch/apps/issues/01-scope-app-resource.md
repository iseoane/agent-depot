# 01: Record the App resource in SPEC, CONTEXT, and an ADR

**What to build:** Promote the deferred "CLI application" category to an **App** resource, as defined in `.scratch/apps/spec.md`.
- Update SPEC.md (scope and exclusions) and DESIGN.md.
- Add the **App** and **App recipe** terms to CONTEXT.md.
- Write an ADR recording two decisions: the App lifecycle is delegated to user-declared recipes, and Agent Depot does not track what an App writes, does not clone App repositories, and ships no built-in recipes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] SPEC.md and DESIGN.md no longer list CLI applications as deferred, and they describe App scope and exclusions.
- [x] CONTEXT.md defines App and App recipe and replaces the CLI application entry.
- [x] A new ADR in docs/adr records the delegation and no-tracking decisions.

## Verification

- Documentation-only scope; TDD and a runtime harness are not applicable because no runtime behavior changes.
- `pnpm typecheck`: passed.
- `pnpm test:single tests/version.test.ts`: 8 passed, 0 failed.
- `pnpm test`: 521 passed, 0 failed.
- `git diff --check`: passed.
- Code review against starting HEAD `c2745ee2e023aa50211f1d94e2f6b15ab2166b5e`: Standards and Spec reviewed separately in-process (parallel sub-agent tooling unavailable). No remaining findings; conflicting TUI-deferred wording and the skill-command confirmation boundary were corrected.
- Rollback boundary: revert the App-scope edits in `SPEC.md`, `DESIGN.md`, and `CONTEXT.md`, remove ADR 0007, and untick this ticket; no runtime files are affected.
