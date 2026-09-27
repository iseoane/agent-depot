# Install user-global Skills

Status: ready-for-agent
Blocked by: 03 Install project-scoped Skills and 04 Adopt existing Skills safely

## What to build

Let users install Skills independently in user-global scope, separate from project installations. All supported CLI invocation modes share the same per-user catalog and state.

## Acceptance criteria

- Users can install selected compatible Skills in user-global scope.
- User-global installations are independent from project-scoped installations.
- User-global installation state is reusable across supported CLI invocation modes.
- All supported CLI invocation modes share one per-user catalog and configuration state.
- User-global installations use the canonical Host mapping, including the confirmed Claude symlink behavior and failure policy.
- Existing identical user-global Skills can use the shared safe adoption behavior.
