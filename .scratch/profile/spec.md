# Profile export and import

Status: needs-triage

## Problem Statement

A user who runs Agent Depot on several machines (Linux, WSL, Windows, a new laptop) rebuilds the same setup by hand on each one: registers the same Git Sources, reinstalls the same user-global Skills on the same Hosts, and copies App recipes around. Nothing captures "my Agent Depot setup" in a portable form.

Project-scope Skills already travel with the repository through `agent-depot.json`. User-global state does not.

## Solution

A versioned, portable **profile** file (`agent-depot-profile/v1`, JSON) that Agent Depot can export from one installation and import into another.

- The CLI gains `agent-depot export` and `agent-depot import <file>`.
- The TUI gains a fifth tab, **5 Import/Export**, after Updates. This is an explicit exception to "no new tabs" (record it in an ADR).
- Export and import both show a checklist, so the user chooses what to take and what to apply.
- Import only adds what is missing. It never removes, replaces, or changes anything already present in the destination.

## Profile contents

| Block | Contents | Excluded |
|---|---|---|
| `sources` | Git Source URLs and whether each is included in discovery | Local-path Sources (not portable, same rule as `--portable-v1`); the built-in Source (always present) |
| `skills` | User-global selections: Source identity (built-in or canonical Git URL), Skill path, version policy as recorded, Hosts, user-provided methods | Unmanaged Skills, App-owned Skills, project-scope Skills, installation locations |
| `apps` | The full content of each App recipe file, including `platform` | Approval receipts, installed state, pending updates |

The file contains no credentials, no absolute local paths, and no machine-specific state. It is meant to be readable and safe to keep in git.

## Export

- `agent-depot export [--out <file>]` writes the profile (stdout by default).
- Selection: everything by default; the CLI accepts filters (`--no-sources`, `--no-skills`, `--no-apps`, and repeatable `--source/--skill/--app <name>`); the TUI shows a checklist grouped by block.
- The preview lists what will be written and what was excluded and why (for example "local-path Source, not portable").

## Import

- `agent-depot import <file> [--yes]` builds a plan and previews it before anything is written.
- Plan, per item: **add** (missing in the destination), **same** (already present and identical, skipped), or **conflict** (present but different, skipped with the difference shown). Nothing present is changed.
- Selection: the TUI shows the plan as a checklist (add items checked by default); the CLI accepts the same filters as export.
- Apply order: Sources first, then Skills (install through the existing install flow with the recorded Hosts and version policy), then App recipes (written to the destination `apps/` directory).
- One item's failure does not stop the others; results are summarised per item, as in the update batch.
- Imported App recipes arrive **unapproved**. Approval is per machine and never travels in the file. Apps are never installed by import; after import they appear in Sources (App recipes) and Installations.
- User-provided methods are imported as declared and keep the existing safety contract: they are previewed and confirmed before they ever run.
- A recipe for another platform is imported (it may be useful later) and shows as "not applicable" in the destination.

## Safety

- Same preview-and-confirm contract as every other write flow; `--yes` is required to apply from the CLI.
- The profile parser is strict: unknown versions, unknown fields, local paths, and invalid recipes are rejected with field paths, before any write.
- Import writes through existing core operations (source registration, Skill install, recipe directory); it adds no new file-writing paths beyond writing recipe files.

## Out of scope

- Removing or syncing extra items in the destination.
- Project-scope Skills (use `agent-depot.json`).
- Transferring approvals, installed versions, backups, or Source caches.
- Encrypted or signed profiles.

## Decisions

- A conflicting App recipe is skipped like any other conflict; there is no "save as copy" option.
- The profile records the Agent Depot version that produced it (`agentDepotVersion`); import warns, without failing, when it is newer than the running version.
