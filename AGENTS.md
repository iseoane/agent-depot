## Agent skills

### Issue tracker

Issues and specs live as local Markdown files in `.scratch/` for now; GitHub Issues is planned for later. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels documented in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo; read root `CONTEXT.md` and relevant ADRs in `docs/adr/`. See `docs/agents/domain.md`.

<!-- POTETO-MATT-INTEGRATION:START -->

## Poteto + Matt integration

Use `poteto-mode` as the primary orchestrator for non-trivial engineering work.

Do not start a second implementation workflow when `poteto-mode` is active.
Pstack owns implementation, debugging, testing, verification, and engineering
orchestration.

### Supporting skills

Use Matt Pocock skills as supporting primitives when relevant:

- `domain-modeling` when changing domain concepts, terminology, entities,
  relationships, or invariants.
- `codebase-design` when designing or restructuring modules, interfaces,
  seams, boundaries, or abstractions.
- `grilling` only when a genuine product or domain decision remains after
  exhausting available evidence.
- `research` when external or primary-source investigation is required.
- `code-review` when a meaningful specification or explicit requirements
  exist and the finished implementation should be checked against them.

These skills support `poteto-mode`; they do not replace its implementation
workflow.

### Explicit Matt workflows

Keep these available independently:

- `triage` for issue investigation and preparation.
- `to-spec` when a durable implementation specification is the desired output.
- `improve-codebase-architecture` for deliberate architecture improvement.

Do not automatically turn non-trivial tasks into specifications.

<!-- POTETO-MATT-INTEGRATION:END -->
