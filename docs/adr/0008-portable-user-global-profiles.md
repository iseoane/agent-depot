# Portable user-global profiles and an Import/Export tab

Status: Accepted

A Profile transfers user-global choices rather than machine state. Strict JSON
`agent-depot-profile/v1` contains `agentDepotVersion`, Git Sources (`url`, `included`),
portable Skill selections (the project-manifest shape without `installation`),
full App recipe contents, and optional Package selections. `agent-depot-profile/v2`
adds a `replicas` array of identity-only intent for Skills, Apps, and Packages
confirmed installed on the exporting machine. It carries no installed version,
receipt, local path, Host approval, or installation evidence. Every replica must
reference a corresponding Skill, App recipe, or Package declaration in the same
Profile. The new parser reads v1 with no replica intent; serialization uses v1
when replicas are empty and v2 otherwise. This is legacy-input compatibility, not
forward compatibility: older v1-only readers reject v2. Unknown fields and versions
remain errors.

Reuse manifest, recipe, and Package validators in shared core operations, following
ADR 0006. Existing App inspection and Package host-state inspection may establish
current installation evidence through their read-only ports; stale App records do
not establish installation. Unknown inspection remains unknown, not absent or
installed. Export excludes local Sources, unmanaged and App-owned Skills, project
selections, installation locations/evidence, caches, approvals, and pending updates.
Recipe free text gets conservative portability checks as well as normal recipe
validation. Do not claim arbitrary secret detection.

Import is add-only: add missing items, skip identical items, and show and skip
conflicts. Apply Sources, then Skills through the existing confirmed install flow,
then recipes. Independent failures do not stop the batch. Recipes arrive unapproved; Apps are not installed by import. Replica intent is a
record of origin-machine installation identity only. Import previews it for context
but does not approve, install, or otherwise act on it. Package selection remains a
selection, not an installation. Approval is machine-local and never travels. A
newer producing Agent Depot version warrants a warning, not rejection.

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
file or follows an existing symlink. Export does not refresh Sources, approve
recipes, or run lifecycle commands. It may use the existing approved App version
probe and read-only Package host inspection to classify origin-machine replica
intent; these inspections do not reconcile records or run install/update commands.
Invalid/nonportable export candidates are excluded with reasons; strict parsing
rejects such items in incoming profiles.

### Ticket 01 review corrections

Canonical output orders Sources by URL, Skills by Source identity/path and recipes
by name/platform, independent of insertion order. A missing Source block for an
exported external Skill warrants a preview warning, not forced inclusion. Export
uses the existing read-only global inventory to name unmanaged Skills, with an
injectable home directory, and reports only exclusions that actually occurred.

URL query keys associated with credentials are rejected in portable declaration
text. Home-relative manual guidance is portable; version/latest regex patterns
are not filesystem paths. Manifest-derived Skill failures are rethrown as profile
field-path diagnostics. Existing `--out` files remain untouched with a suggestion
to choose another path.
