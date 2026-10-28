# Issue tracker: GitHub Issues

Issues and specs for this repo live in GitHub Issues at `iseoane/agent-depot`.
Use the `gh` CLI. Older specs under `.scratch/` remain readable history.

## Conventions

- One issue per feature or bug; a spec is the issue body or a linked parent issue
- Implementation tickets are separate issues linked to their parent
- Triage state is expressed with the canonical labels in `docs/agents/triage-labels.md`
- Comments and conversation history live in the issue's comments

## When a skill says "publish to the issue tracker"

Create a GitHub issue with `gh issue create` and the `needs-triage` label.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`. The user will normally pass the issue number or URL directly.
