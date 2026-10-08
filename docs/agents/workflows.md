# Engineering workflows

## Supporting skills

Use these Matt Pocock skills when their triggers apply. They supplement
`poteto-mode`; they do not replace its implementation workflow.

- Use `domain-modeling` when changing domain concepts, terminology, entities, relationships, or invariants.
- Use `codebase-design` when designing or restructuring modules, interfaces, seams, boundaries, or abstractions.
- Use `grilling` only when a genuine product or domain decision remains after the available evidence is exhausted.
- Use `research` when external or primary-source investigation is required.
- Use `code-review` when a meaningful specification or explicit requirements exist and the finished implementation needs a requirements check.

## Independent Matt Pocock workflows

Keep these workflows available independently when the user explicitly requests them:

- Use `triage` to investigate and prepare an issue.
- Use `to-spec` when the requested deliverable is a durable implementation specification.
- Use `improve-codebase-architecture` for deliberate architecture improvement.

Do not turn non-trivial work into a specification by default.

## Read durable decisions before changing them

`CONTEXT.md` defines the domain language. Relevant ADRs record product and
architecture decisions. Before changing a resource lifecycle, ownership, approval,
or installed-state handling, read the applicable ADRs. ADR 0006 defines the shared
write-flow boundary: keep mutations in shared core flows; CLI and TUI collect
inputs, show previews, and request confirmation. ADR 0007 defines delegated App
recipe ownership. ADR 0009
defines Package command approval and read-only Host state. Treat confirmed Package
installation separately from installed-version and update evidence: unavailable
version evidence does not make an installed Package absent or prove an update.
Keep those decisions in
their ADRs rather than copying their rationale into agent instructions.
