## Agent guidance

This repository develops Agent Depot, a cross-platform manager for coding-agent
resources.

Before exploring implementation or domain behavior, read root `CONTEXT.md` and
relevant ADRs in `docs/adr/`. Follow `docs/agents/domain.md`.

When investigating, triaging, or editing an issue or spec, follow
`docs/agents/issue-tracker.md` and use the canonical labels in
`docs/agents/triage-labels.md`.

## Test isolation

When testing state-writing flows, load `tests/isolated-env.ts` and inject temporary
state paths. A temporary `homeDirectory` alone does not override inherited XDG or
Pi environment paths. Verify that writes stay inside the test sandbox.

<!-- POTETO-MATT-INTEGRATION:START -->

## Engineering workflow

For non-trivial engineering work, use `poteto-mode` as the primary orchestrator.
Do not start a second implementation workflow while it is active. Pstack owns
implementation, debugging, testing, verification, and engineering orchestration.
When choosing supporting skills or running an explicit Matt Pocock workflow,
read `docs/agents/workflows.md`.

<!-- POTETO-MATT-INTEGRATION:END -->
