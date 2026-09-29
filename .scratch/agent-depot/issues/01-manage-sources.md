# Manage Sources before discovery

Status: completed
Blocked by: None (can start immediately)

## What to build

Let users add external Sources by URL, list registered Sources, refresh each external Source at its stable URL, see the read-only built-in Source, and decide which Sources are considered for discovery. A changed URL is represented as a new Source rather than an in-place mutation. Source removal with dependent Skills is covered by ticket 08.

## Acceptance criteria

- Users can add an external Source by URL.
- Users can list registered external Sources and refresh each one at its registered URL.
- The read-only built-in collection is visible as a Source.
- Users can choose which registered or built-in Sources are considered before discovery.
- Registering a Source does not select or install every Skill from it.
- Changing a Source URL creates a new Source identity instead of silently changing the existing Source.
- This ticket does not remove Sources with dependent installed Skills.
