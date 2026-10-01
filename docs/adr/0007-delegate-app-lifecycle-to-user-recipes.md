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
metacharacters are literal. `/`, `\` and NUL are invalid. No path existence,
content, link target or App provenance is verified for an excluded entry.

The shared core filter is used by CLI/TUI inventory and write guards; write
execution reloads declarations to protect against recipes added after preview.
Missing recipe directories mean no exclusions. Loading/validation failures
(including duplicate applicable names or invalid patterns) disable all exclusions
and produce a visible warning; Skill listing remains usable. Ownership labels
are deferred rather than inspecting or inventing App artifact records.
