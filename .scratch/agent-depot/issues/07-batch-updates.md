# Update Skills in batches

Status: ready-for-agent
Blocked by: 04 Adopt existing Skills safely, 05 Install user-global Skills, and 06 Run user-provided methods safely

## What to build

Let users choose fixed or latest version policies and review available updates as one batch. Users can update all available Skills or a subset. Unknown version status is not updateable. Independent update failures do not stop the remaining selected updates, and results are summarized. Installed copies from the built-in collection change only through this batch.

## Acceptance criteria

- An installation can use either a fixed version policy or the latest version policy.
- Available updates are presented together as one batch.
- Users can update all available Skills or a selected subset.
- Skills with unknown version status are shown separately and are not treated as updateable.
- A failed independent update does not prevent remaining selected updates from running.
- The batch summarizes successful and failed updates.
- Any external update method is previewed with the intended changes and requires explicit confirmation before execution.
- Installed copies from the built-in collection change only through the normal update batch.
