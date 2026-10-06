---
name: "agent-depot-apprecipe"
description: "Trigger: App recipe creation or repair. Research an App's actual install channel and write platform-aware Agent Depot recipes."
license: MIT
metadata:
  author: "iseoane"
  version: "1.2"
---

## Activation Contract

Use for creating or repairing user-global App recipes, not portable Skills.

## Hard Rules

- Read `agent-depot app schema` first: it is the format source of truth. Research upstream README, install docs and releases through the web or GitHub API; never clone the App repository.
- Write user-owned JSON in the environment-local `apps/` beside `sources.json`. Preserve existing files unless the user authorizes replacement. Keep Apps out of Sources and project manifests.
- Never approve a recipe on the user's behalf. Approval belongs to the user via `agent-depot app approve <name> --yes`; changed bytes need renewed approval. Validation is not approval.
- Use bare executable-plus-arguments arrays, without shells, shell syntax, credentials or environment assignments. Script-only routes (`curl | sh`, PowerShell scripts, `.cmd`) belong in `manual` text, never pipe-to-shell argv. Agent Depot displays manual text without executing it.
- Steps run from the user's home with stdin EOF and no timeout. Verify non-interactive behavior against the installed installer's help/version, not just an upstream quickstart. Use supported non-interactive flags; terminal-dependent installers belong in manual steps.
- Preflight the chosen channel before writing lifecycle steps. Missing prerequisites must be declared, never silently installed, configured or trusted. Recipe approval does not authorize separate prerequisite installation.

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
| Missing manager, runtime, PATH entry, repository/tap, permissions or hook dependency | Explain the blocker and preparation before approval. Use a complete manual route or ask whether the user wants an explicitly prerequisite-dependent recipe; never call it ready to install. |
| Installer needs several commands | Use schema-supported ordered steps only if present. Otherwise put the complete sequence in `manual` or obtain the user's explicit choice of the prerequisite-dependent route below; never invent dependency fields, concatenate commands in argv, or hide preparation in a fallback. |

## Installer Preflight

Check installation **and** update, uninstall, version/latest and each Host setup/teardown. Record evidence as satisfied, missing or unverified:

- **Executable and environment:** inspect all manager/runtime PATH matches, resolved paths and versions in the environment Agent Depot actually inherits. A shell alias/function is not a spawnable executable. A terminal's PATH change does not reach an already-running TUI; tell the user to relaunch it from the prepared environment. Prefer read-only checks; do not create shims or edit shell configuration merely to make validation pass.
- **Channel registration and trust:** inspect required taps, repositories, registries and plugin marketplaces, their identities and current package metadata. Verify whether this installer version auto-registers them or requires explicit preparation; do not assume historical behavior. Report missing registration before writing argv. Registration can clone repositories and execute package definitions: do not run it as a supposedly read-only probe or without user authorization.
- **Runtime/build and hook requirements:** verify documented engine ranges, compiler/toolchain minimums, architecture/libc support and utilities such as `git`, `curl`, `jq` or extraction tools. Check write access to the actual global prefix and required elevation; never assume sudo or request credentials in chat. Inspect prerequisites for Host plugins separately from the App binary.
- **Unattended behavior:** use installed manager `--help`/documented help and upstream installer source to establish confirmation defaults and supported flags. Verify explicit formula/cask or package disambiguation where necessary. Do not invent `--yes` flags or rely on stdin EOF to count as consent. Run dry-run/read-only probes only after checking they do not install, register, authenticate or rewrite configuration; never test a lifecycle command just to see whether it prompts.
- **Version and update signals:** verify a release-meaningful version (not an unchanged `dev`) and a latest signal for the chosen channel. A GitHub release can be ahead of a package-manager formula. Use channel metadata when available and disclose freshness limits; do not run `brew update` or another mutating refresh as a read-only latest probe.
- **Preserved state:** identify existing binary copies, data directories and Host wiring without reading private memory content. Explain migrations, backups and teardown scope outside executable argv where appropriate; never delete user data or remove a shared tap/marketplace implicitly.

### Homebrew checklist

Inspect `brew --version`, `brew help install`, `brew help upgrade`, `brew help uninstall`, `brew tap` and `brew list --versions`. Resolve `brew` from Agent Depot's PATH. Check the actual tap formula/cask and its release rather than trusting a possibly stale README. Homebrew auto-updates taps only for `install`, `outdated`, `upgrade`, `bundle`, `release` and `tap <name>`, never `info`, so `brew info --json=v2 <tap>/<formula>` reports the local clone's last refresh and lags a published release. When the tap mirrors a GitHub release, declare `latest` as `{"github": "owner/repo"}`; install and upgrade refresh the tap themselves. Use supported non-interactive flags for install/update and `--formula` or `--cask` when names conflict. Do not assume `brew install owner/tap/name` registers a missing tap automatically.

For example, Homebrew 7.0.8 encountered during recipe research required an explicit `brew tap gentleman-programming/tap`; its install help documented ask-by-default and `--yes`. This is version-specific evidence, not a universal flag or a claim about when the behavior changed. Recheck the user's installed version.

### Representing preparation

Read the current schema; do not assume it has dependency or multi-command fields. When a required tap is missing and a lifecycle step accepts only one argv, `install.manual` can describe both registration and installation. Alternatively, with the user's explicit choice, retain automated install as prerequisite-dependent and provide the preparation commands and blocked status clearly in the handoff. An `argv` plus `manual` step falls back **only on spawn failure**: it cannot perform preparation before argv and does not handle a non-zero exit. Keep manual text concise; put research and caveats in the handoff. Never approve either route on the user's behalf. Execute preparation only with separate user authorization; execute recipe commands only after user approval and an explicit execution request.

## Execution Steps

1. Record upstream evidence and platform support. Inspect all PATH matches (`which -a`/`whence -a`, or Windows `Get-Command -All`), resolved paths, and channel inventories such as `brew list`, `npm ls -g` or `pipx list`. List Windows shims seen from WSL separately: `/mnt/<drive>/` executables cannot serve a Linux recipe. Finish only when the actual channel is established or the user has chosen one.
2. Complete the Installer Preflight and resolve the prerequisite decision gate before writing required `name`, `install`, `update`, `uninstall`, and `version`. Each lifecycle step uses `argv`, `manual`, or both; manual fallback applies only to spawn failure, never non-zero exit. `version` needs read-only argv and a JavaScript regex with exactly one capture group. Choose optional `latest` as `github: owner/repo`, `npm: package`, or read-only `argv` plus `pattern`; omit it when unknown. Consult [the illustrative example](assets/example.md), not as upstream command evidence.
3. Put user-global Host wiring in optional `setup`/`teardown` maps keyed by `pi`, `claude`, `codex`, or `opencode`. Keep install separate; uninstall never implicitly runs teardown. Delegate wiring to App commands or manual user instructions, not direct agent edits of Host configuration. Exclude project initialization.
4. Declare optional `skills` only for documented App-owned directory/link names. Match whole names case-sensitively; only `*` is special, while `?` and brackets are literal. Reject empty/whitespace-only, path separators, NUL and star-only patterns. These declarations filter unmanaged adoption/removal even before approval/install; they verify no artifacts or provenance.
5. Run `agent-depot app validate <file>...` for current-platform recipes. Fix structural errors; report unapproved recipes as needs approval, not runtime-verified. Distinguish structural validity, recipe approval, prerequisite readiness, installed version and Host wiring; none proves the others. A known missing prerequisite remains a blocker even when validation succeeds. Version commands run only for approved applicable content. Mark other platforms unverified. After user approval, the user can inspect `app list` and separately preview `app install|update|uninstall <name>` or `app setup|teardown <name> --host <host>`.

## Output Contract

Return file paths, platform/channel evidence, a concise prerequisite status (satisfied/missing/unverified) with preparation commands and whether the recipe is ready or blocked, validation results and runtime-verification limits; unsupported platforms; omitted optional fields and why; license, telemetry/update-check behavior (or unknown); and conflicting duplicate install routes, including plugin-marketplace versus setup routes. Explain that version alone determines installed state, updates require a changed version, and unknown latest is not an available update. End with the user's approval command, without running it.
