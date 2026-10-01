# Portable user-global profiles and an Import/Export tab

Status: Accepted

A Profile transfers user-global choices rather than machine state. Use strict JSON
`agent-depot-profile/v1` with `agentDepotVersion`, Git Sources (`url`, `included`),
portable Skill selections (the project-manifest shape without `installation`),
and full App recipe contents. Reuse manifest and recipe validators in shared core
operations, following ADR 0006. Exclude local Sources, unmanaged and App-owned
Skills, project selections, installation locations/evidence, caches, approvals,
installed-App records and pending updates. Reject unknown fields and versions,
local paths and obvious credentials; recipe free text gets conservative portability
checks as well as normal recipe validation. Do not claim arbitrary secret detection.

Import is add-only: add missing items, skip identical items, and show and skip
conflicts. Apply Sources, then Skills through the existing confirmed install flow,
then recipes. Independent failures do not stop the batch. Recipes arrive unapproved;
Apps are not installed by import. Approval is machine-local and never travels.
A newer producing Agent Depot version warrants a warning, not rejection.

Approve a fifth TUI tab, **5 Import/Export**, after Updates: an explicit exception
to the no-new-tabs direction. Existing keys 1–4 and App lifecycle views retain their
meaning. Import and this tab are subsequent tickets, not part of export ticket 01.

Discovery choices currently exist only as frontend inputs, not persisted state.
Export defaults registered Sources to `included: true`, matching Catalog's default;
its core accepts explicit included Source IDs for frontend choices. Block filters
select independently: exporting a Skill does not force its Source block to be
included because the Skill carries a self-contained Source identity. Multiple App
recipes with the same name but different platforms travel independently.

CLI export sends JSON only to stdout and its preview/exclusion diagnostics to
stderr. `--out` creates a new file exclusively; it never overwrites an existing
file or follows an existing symlink. No Source refresh, recipe approval or command
execution occurs during export. Invalid/nonportable export candidates are excluded
with reasons; strict parsing rejects such items in incoming profiles.
