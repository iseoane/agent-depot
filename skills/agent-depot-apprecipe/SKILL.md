---
name: "agent-depot-apprecipe"
description: "Trigger: App recipe creation or repair. Research an App's actual install channel and write platform-aware Agent Depot recipes."
license: MIT
metadata:
  author: "iseoane"
  version: "1.0"
---

## Activation Contract

Use for creating or repairing user-global App recipes, not portable Skills.

## Hard Rules

- Read `agent-depot app schema` first: it is the format source of truth. Research upstream README, install docs and releases through the web or GitHub API; never clone the App repository.
- Write user-owned JSON in the environment-local `apps/` beside `sources.json`. Preserve existing files unless the user authorizes replacement. Keep Apps out of Sources and project manifests.
- Never approve a recipe on the user's behalf. Approval belongs to the user via `agent-depot app approve <name> --yes`; changed bytes need renewed approval. Validation is not approval.
- Use bare executable-plus-arguments arrays, without shells, shell syntax, credentials or environment assignments. Script-only routes (`curl | sh`, PowerShell scripts, `.cmd`) belong in `manual` text, never pipe-to-shell argv. Agent Depot displays manual text without executing it.
- Steps run from the user's home with stdin EOF and no timeout. Use non-interactive flags; terminal-dependent installers belong in manual steps.

## Decision Gates

| Evidence | Recipe decision |
|---|---|
| Identical steps on all supported platforms | Omit `platform`. |
| Steps differ by OS or architecture | Use separate files with the same App `name` and explicit `linux`, `windows` or `darwin`; ask about architecture where needed. Never create duplicate applicable names. |
| Unsupported platform | Report it; invent no steps. WSL is Linux, not Windows. |
| Several installs or uncertain channel | List every path/channel and ask the user to choose before writing lifecycle steps. |
| brew / npm / pipx | Derive update and uninstall from that channel: upgrade/uninstall, global install/uninstall, or upgrade/uninstall respectively. |
| Go install / release binary | Use the documented update route and a manual binary-removal step. |
| App has its own uninstall | Prefer it after verifying scope and non-interactive flags; explain remaining channel cleanup. |

## Execution Steps

1. Record upstream evidence and platform support. Inspect all PATH matches (`which -a`/`whence -a`, or Windows `Get-Command -All`), resolved paths, and channel inventories such as `brew list`, `npm ls -g` or `pipx list`. List Windows shims seen from WSL separately: `/mnt/<drive>/` executables cannot serve a Linux recipe. Finish only when the actual channel is established or the user has chosen one.
2. Write required `name`, `install`, `update`, `uninstall`, and `version`. Each lifecycle step uses `argv`, `manual`, or both; manual fallback applies only to spawn failure, never non-zero exit. `version` needs read-only argv and a JavaScript regex with exactly one capture group. Choose optional `latest` as `github: owner/repo`, `npm: package`, or read-only `argv` plus `pattern`; omit it when unknown. Consult [the illustrative example](assets/example.md), not as upstream command evidence.
3. Put user-global Host wiring in optional `setup`/`teardown` maps keyed by `pi`, `claude`, `codex`, or `opencode`. Keep install separate; uninstall never implicitly runs teardown. Delegate wiring to App commands or manual user instructions, not direct agent edits of Host configuration. Exclude project initialization.
4. Declare optional `skills` only for documented App-owned directory/link names. Match whole names case-sensitively; only `*` is special, while `?` and brackets are literal. Reject empty/whitespace-only, path separators, NUL and star-only patterns. These declarations filter unmanaged adoption/removal even before approval/install; they verify no artifacts or provenance.
5. Run `agent-depot app validate <file>...` for current-platform recipes. Fix structural errors; report unapproved recipes as needs approval, not runtime-verified. Version commands run only for approved applicable content. Mark other platforms unverified. After user approval, the user can inspect `app list` and separately preview `app install|update|uninstall <name>` or `app setup|teardown <name> --host <host>`.

## Output Contract

Return file paths, platform/channel evidence, validation results and runtime-verification limits; unsupported platforms; omitted optional fields and why; license, telemetry/update-check behavior (or unknown); and conflicting duplicate install routes, including plugin-marketplace versus setup routes. Explain that version alone determines installed state, updates require a changed version, and unknown latest is not an available update. End with the user's approval command, without running it.
