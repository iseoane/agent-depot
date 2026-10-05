# Delegate App lifecycle to user-declared recipes

Status: Accepted (2026-10-01)

## Context

Applications such as Engram, CodeGraph, and GitNexus are not portable skills. Their install channels and Host wiring differ, and their commands can create skills, MCP entries, plugins, hooks, or instruction blocks. Owning those artifacts would require Agent Depot to replicate each application's setup and recovery logic.

## Decision

Promote App to a supported, user-global resource category alongside Skill. Delegate install, update, uninstall, and optional per-Host setup and teardown to commands in user-declared App recipes. Preview and confirm lifecycle steps; approve recipe content before running any recipe command. Use the recipe's version command to determine installed state.

Agent Depot does not track, snapshot, or verify what an App writes, edit Host configuration on its behalf, clone App repositories, or ship built-in recipes. Recipes are user-owned files, not Source resources. The App's own commands own its artifacts.

Recipes live in `apps/` beside environment-local `sources.json`; private atomic approvals in sibling `app-approvals/` are keyed by canonical file path and exact content hash. CLI approval is only `app approve <name> --yes`, never validation. WSL manages Linux only and skips Windows drive PATH candidates.

## Consequences

- Users must supply recipes matching their actual install channel; Agent Depot does not provide an App catalog or infer artifact ownership.
- Agent Depot tracks App identity and installed version, not filesystem provenance or rollback of App-created artifacts. A successful version check does not prove Host wiring is correct.
- Declared owned-skill names/globs only exclude skills from unmanaged adoption/removal; they do not verify those paths.
- CLI and TUI use shared core flows, and Apps join existing Installations and Updates views. Project-scoped Apps and per-project steps remain out of scope.
- Update-selection CLI grammar and teardown-before-uninstall are resolved below. Other open questions are in `.scratch/apps/spec.md`; recipe placement, approval and WSL environment boundaries are resolved.

## Lifecycle implementation decisions (ticket 03)

Installed-App records live in sibling `app-installations/`, keyed by hashed App name and published using the existing atomic-file adapter. This keeps App state separate from the strict Source/Skill state schema and avoids shared read-modify-write updates. Records contain identity, canonical recipe path and verified installed version only.

Uninstall never implicitly runs Host teardown: teardown remains separately previewed and confirmed. The non-interactive CLI uses `--manual-done --yes` to attest manual completion, and `uninstall --forget --yes` to explicitly drop tracking without running commands.

### Ticket 04 Host lifecycle decisions

- Setup/teardown reuse lifecycle plans and execution, with repeated `--host <host>` selections. Duplicate, unknown or undeclared Hosts are rejected before execution. Every selected Host is previewed; independent execution failures are reported per Host and do not stop remaining selections.
- Host actions do not persist wiring state or change installed-App records. Automated success means only that the delegated command succeeded. Manual completion uses `--manual-done --yes` and requires a successful version check, which does not verify Host wiring (including teardown).

### Ticket 05 update decisions

- User-global `update apply` accepts repeated `--app <name>` alongside existing `--skill` selections; `--all` includes both. Project scope never selects Apps. Manual batch outcomes direct users to `app update <name> --manual-done --yes`.
- Latest HTTP lookups use anonymous public GitHub Releases/npm endpoints, no redirects, a five-second timeout and a 1 MiB response cap. Missing/unresolvable latest is unknown. Strict SemVer versions (ignoring a leading `v`) are updateable only when latest is newer, including prerelease ordering; installed versions at or ahead of latest are current. Opaque versions retain inequality, which can offer a downgrade. The existing Skill comparator is deliberately permissive, so Apps use a strict comparator without changing Skill behavior.

### Ticket 05 review: verified update outcomes

Update plans carry the pre-update installed version and the selected latest version
(or unknown). Automated and manual updates succeed only when the post-update
`version` differs from the pre-update version. Equality uses the same leading-`v`
normalization as availability checks and strict SemVer equality (ignoring build
metadata) when both versions parse. An unchanged version fails with
`version unchanged (<old>); expected <latest>` and leaves installed tracking
unchanged. A changed version may differ from latest; report
`installed <old> -> <new> (latest <latest>)` and record the verified new version.

Confirmed manual fallbacks persist the pre-update version and latest in private,
atomic sibling `app-pending-updates/` records, bound to canonical recipe path and
content hash. `--manual-done` uses this baseline across CLI invocations. An
attested manual-completion attempt consumes the baseline even on failure; retry
requires a fresh confirmed preview. Successful automated updates also remove it. This is version evidence, not tracking App-written artifacts.


### Ticket 05 review: public registry lookup

npm lookup validates package names and reads `dist-tags.latest` from package
metadata, with scoped slash encoding (`@scope%2Fname`) and npm's install-v1 media
type. GitHub lookup rejects dot-prefixed identity segments, encodes each segment,
and sends the package-version User-Agent, GitHub media type and API version.
`/releases/latest` excludes drafts and prereleases. No redirects are followed,
including same-origin ones; redirect, rate-limit, HTTP-status, timeout, oversize
and malformed-response reasons remain visible in checks and listings.


Batch planning reuses the already-loaded App update check, bound to the same
canonical recipe path and content hash, rather than fetching latest again.
Approval and executable rechecks still run before execution.

### Ticket 08 owned-Skill declarations

Applicable valid recipes exclude declared Skill directory/link names from unmanaged
inventory, adoption and removal, even when unapproved or not installed. Reading
JSON runs no command; approval gates execution, not declarative ownership. Managed
installation records remain authoritative and are not hidden by this filter.

Matching is case-sensitive against the entire immediate directory/link name,
not `SKILL.md` metadata or a path. Only `*` is special: zero or more characters
within a name. Repeated stars behave like one star; `?`, brackets and regex
metacharacters are literal. Empty/whitespace-only patterns, `/`, `\`, NUL and
star-only patterns (including repeated stars) are rejected by recipe parsing and
the JSON Schema; the matcher retains a defensive validation check. No path existence,
content, link target or App provenance is verified for an excluded entry.

The shared core filter is used by CLI/TUI inventory and write guards; write
execution reloads declarations to protect against recipes added after preview.
Missing recipe directories mean no exclusions. An invalid recipe (including an
invalid pattern or duplicate applicable name) is skipped with a warning naming
its file; other valid applicable recipes still exclude their owned Skills.
Defensively rejected matcher patterns are skipped individually with a file-named
warning. Only a failure to load the recipe directory disables all exclusions;
Skill listing remains usable. Ownership labels
are deferred rather than inspecting or inventing App artifact records.

### Ticket 11 recipe management in Sources

Sources hosts App recipes alongside Skill Sources, not in a new tab. Recipes
remain user-owned files, not Source resources. The original Tab-based section
focus is superseded by one windowed list and cursor: j/k and arrows traverse
both kinds. The KIND column is `skills` for Git Sources and `app` for recipes;
this is a UI resource label, not a change to the persisted Git Source schema.
The footer follows the selected row. Enter opens a Skill Source's Catalog or
previews/approves an App recipe; n adds a Source or guides recipe creation;
r refreshes Skill Sources or reloads recipe status. Marks apply only to Skill
Sources. Listing/reload parse recipes and check approval only; they never run
version/latest commands. Recipe load errors stay local. Changed recipe content
requires renewed approval.

The explicit d removal action may run an approved version check. If an App is
installed or still tracked, ask whether to uninstall first using the existing
lifecycle plan/execution/manual-completion core. Declining cancels removal;
a failed uninstall retains the recipe. Recipe deletion has a separate exact-path
preview and confirmation, rechecks content and file identity, and verifies the
App is no longer installed or tracked. A version command that never ran proves
nothing about the App, so an unresolvable or blocked version executable fails
the removal closed; a recipe for another platform cannot have its installed
state checked here and stays removable. It unlinks only the recipe (a symlink's
target survives), never App data or Host configuration. Unapproved recipes must
be approved before commands run; invalid recipes must be repaired before removal
can verify their App state. Approval receipts are left unchanged; later content
still needs its matching approval.

The add guide has exactly two routes: the built-in `agent-depot-apprecipe` Skill
(install if missing through the existing Catalog flow, then show an agent prompt),
or manual JSON authoring in the displayed `apps/` directory using
`agent-depot app schema`. Lifecycle actions otherwise stay in Installations and
Updates; the optional uninstall prerequisite for recipe removal reuses that same
core without silently uninstalling an App.
