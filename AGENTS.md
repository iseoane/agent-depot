## Agent guidance

Before exploring implementation or domain behavior, follow `docs/agents/domain.md`.

When investigating, triaging, or editing an issue or spec, follow
`docs/agents/issue-tracker.md` and use the canonical labels in
`docs/agents/triage-labels.md`.

## Test isolation

When testing state-writing flows, load `tests/isolated-env.ts` and inject temporary
state paths. A temporary `homeDirectory` alone does not override inherited XDG or
Pi environment paths. Verify that writes stay inside the test sandbox.

<!-- POTETO-MATT-INTEGRATION:START -->

## Engineering workflow

For non-trivial engineering work, use the isSWF coordinator as the primary
orchestrator (`/isswf:isswf-coordinator`; project setup in `.isswf/project-setup.md`).
When the operator addresses the "coordinator"/"coordinador", enter that flow before
acting. Keep plans, briefs, attempts, reviews and delivery records under
`.isswf/initiatives/<ID>/` from the first dispatch.
Keep one implementation workflow active.
When choosing supporting skills or running an explicit Matt Pocock workflow,
read `docs/agents/workflows.md`.

<!-- POTETO-MATT-INTEGRATION:END -->
