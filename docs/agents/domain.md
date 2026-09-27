# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root, or `CONTEXT-MAP.md` if it exists
- `docs/adr/` for ADRs relevant to the area

If any of these files don't exist, proceed silently. Don't flag their absence or suggest creating them upfront. The domain-modeling skill creates them lazily when terms and decisions are resolved.

## File structure

This is a single-context repo: one root `CONTEXT.md`, with system-wide ADRs in `docs/adr/`.

## Use the glossary's vocabulary

Use terms as defined in `CONTEXT.md`. If a needed concept is missing, note it for domain modeling rather than silently inventing synonyms.

## Flag ADR conflicts

If a proposed change contradicts an existing ADR, surface the conflict instead of silently overriding it.
