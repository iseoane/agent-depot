# Agent Depot — Minimal Technical Design

**Status:** Minimal V1 architecture approved; implementation details remain open.

## Architecture

Agent Depot is one TypeScript/Node.js package, with pnpm preferred and npm-compatible package metadata. The CLI and existing TUI call the same terminal-independent application operations rather than implement separate workflows. V1 supports Linux and Windows.

V1 manages portable directory-based skills, user-global Apps, and host-native Packages as confirmed resource types. Each managed skill is a portable directory containing `SKILL.md` with required `name` and `description` metadata, optionally with supporting files. Pi-only standalone Markdown skill files are not managed. Agent definitions and MCP servers remain deferred as independently managed categories.

For new skill installations, the canonical target is `.agents/skills` in project scope and `~/.agents/skills` in user-global scope, regardless of whether Claude Code is the only selected host. Claude Code does not document `.agents/skills` as a discovery location, so a Claude-selected installation creates a symlink entry under `.claude/skills` or `~/.claude/skills` that points to the canonical skill directory. This intentionally may expose a Claude-only selection to Pi, Codex, or OpenCode through their shared discovery convention. A matching pre-existing skill is adopted in place without replacing or moving it, even when it is at a noncanonical location; the actual location is tracked. If later host exposure needs another location, require explicit confirmation before moving the skill or creating an additional link or copy. The exact Windows symlink mechanics and runtime validation remain implementation/check prerequisites. If symlink creation fails, including on Windows, stop that target operation with actionable guidance and do not create a duplicate managed copy; preserve the canonical contents and existing conflict protections.

Keep the implementation explicit and small:

- **CLI layer:** Parses commands, renders discovery/update plans, prompts for scope and confirmation, and reports results.
- **Application operations:** Manage Sources (add, list, refresh, remove); discover and select skills; inspect host compatibility; install, update, and uninstall. These operations accept input and return plans/results without depending on terminal UI details.
- **Resource logic:** Explicit source discovery, skill identity, format recognition, skill host compatibility, version checks, and skill installation-method selection.
- **Persistence and adapters:** JSON files, source access, host installation locations for skills, and an injectable command runner.

No generic plugin framework is needed. New supported formats, hosts, and resource categories add explicit logic and tests to the package; deferred categories are not part of the V1 implementation.

### Component and data-flow sketch

```text
Built-in first-party Source ─┐
External Sources ────────────┤
                             v
                     available Source catalog
                             │
                    user-selected Sources
                             │
                             v
                 Source discovery ─> recognized skill candidates
                                             │
                                             v
                               explicit selection / fallback path
                                             │
                    project manifest or global state + host/scope
                                             │
                                             v
                               compatibility and version assessment
                                             │
                                             v
                            plan ─> preview ─> explicit confirmation
                                             │
                                             v
                        skill installation method / command runner
                                             │
                                             v
                               installed state and update batch

CLI and TUI ───────> the same application operations
```

The built-in first-party collection is available as a selectable Source without external registration. Agent Depot does not preconfigure external Sources. The built-in catalog is read-only through the app and package-owned. In V1, each built-in skill version is the Agent Depot package version. Package releases expose newer built-in content; users can select, install, and update its Skills, and Agent Depot changes installed copies only through the normal skill update batch.

## Sources and discovery

The catalog has the built-in first-party Source plus user-registered external Sources. Users can add external Sources by URL, list registered Sources, and refresh a Source at the same stable URL. Changing the URL/ref creates a new Source identity rather than editing in place; existing selections must be explicitly migrated before the old Source is removed. Agent Depot does not preconfigure external Sources. Before discovery, users choose which registered external and/or built-in Sources to scan; discovery scans only those chosen Sources. Registering or refreshing a Source does not auto-select or install Skills.

Discovery recursively scans the chosen source repositories for valid portable skill directories and handles only recognized resource formats; for V1 skills, recognition is limited to candidate directories containing `SKILL.md` with required `name` and `description` metadata. Automatic discovery excludes explicitly lifecycle-marked subtrees from ordinary candidate results, with examples including `in-progress`, `beta`, `deprecated`, and `retired`; it does not delete or modify source content. Pi-only standalone Markdown skill files are excluded. The exact lifecycle marker set and whether explicit path addition overrides the scan filter remain open, as do other scan exclusions (including ignored, generated, or vendor directories and symlinks), duplicate skill-name handling, and collision behavior. If a source or repository is not recognized, the user can explicitly provide the skill and path, preserving a usable escape hatch without making an unsupported file format a supported skill. Source-scan exclusion must not silently select or install anything.

The project root contains `agent-depot.json`. Each selected skill records enough source/skill-path identity to resolve on a fresh machine, its fixed or `latest` version policy, and optional custom install/update commands. A single per-user JSON state file stores reusable external sources, catalog records, and user-global installation state. `pnpm dlx`, `npx`, and a persistent global CLI use this same file. Project and user-global installations remain independent. The exact manifest and state schemas, and the standard Linux and Windows configuration paths, remain open questions.

An already installed skill can be adopted into tracking without reinstalling it when its content exactly matches the selected source, including at a noncanonical location. Adoption records the actual location and does not replace or move the skill. If later host exposure needs another location, moving it or creating an additional link or copy requires explicit confirmation. A same-name installation with different content is a conflict and must not be overwritten without explicit confirmation. The exact content-comparison method and conflict-resolution flow remain open.

## Compatibility and version handling

Compatibility is evaluated for the selected skill hosts before planning execution. An incompatible skill remains visible with a reason and is excluded from `all`; it is never installed for that host. Unknown version status is reported as unknown and is not treated as updateable.

The update operation creates one reviewable batch. The user may select all or a subset of available updates. Independent failures do not stop remaining selected updates; the final result summarizes each outcome.

For new installations, the canonical shared skill path is the installation source for every selected host. An adopted skill remains at its tracked existing location; it is not moved or copied to satisfy a later host target without explicit confirmation. Claude Code consumes a new canonical installation through the selected symlink entry rather than a duplicate content copy; this does not mean Claude Code natively scans `.agents/skills`. If symlink creation fails, including on Windows, the target operation stops with actionable guidance rather than creating a second managed copy. Because the canonical path is also a documented discovery location for Pi, Codex, and OpenCode, selecting Claude alone may expose the skill to those hosts.

## Installation methods and safety

Agent Depot prefers the applicable upstream skill installation/update method. A user-provided fallback method may be stored with the skill in the project manifest or global state. V1 permits one portable command per method, represented as an executable plus an argument list. Commands are invoked without a shell, contain no secrets, and have no per-OS variants; they must work on both Linux and Windows.

Before any external skill command runs, Agent Depot renders the executable and arguments, the intended host/scope/skill changes, and requests explicit confirmation. Uninstallation also requires confirmation.

## App recipes and ownership

Apps use user-owned JSON recipes, separate from Source discovery and project skill manifests. Recipes select platform-specific lifecycle steps and version signals; parsing, step execution, and version/latest lookup are explicit modules behind the injectable command runner, not a generic plugin framework. App write flows share core plans/previews/results between CLI and TUI, following [ADR 0006](docs/adr/0006-shared-core-module-per-write-flow.md). Extend existing Installations and Updates flows without new tabs, top-level modes, or screens; Sources also hosts user-owned App recipe listing, approval, removal and the add guide in the same windowed list as Skill Sources; Catalog labels Source groups by repository name and starts every group collapsed.

Recipe content must be approved before any recipe command runs; changed content invalidates approval. Approval previews every argv. Lifecycle steps still require per-step previews and confirmation. Approved version/latest commands can run without per-run prompts. Reuse user-method argv validation, without shells or credentials, but run App steps from the user's home rather than the project root. Show resolved executable paths and reject Windows executables under `/mnt/<drive>/` on WSL. Display manual text without executing it; fallback to manual only on spawn failure, never on a non-zero exit.

The version command alone determines installed state. Recheck after manual steps: install/update require a successful version check (updates also require a changed pre/post version), and uninstall retains tracking until that check fails or the user explicitly forgets the App. An unknown latest version is not an available update. App updates join the existing batch with per-App failure reporting and continuation.

Agent Depot records App identity and installed version, but does not track, snapshot, or verify App-written artifacts or edit Host configuration on an App's behalf. Recipe-owned skill names/globs filter unmanaged adoption/removal without verifying paths. Do not clone App repositories, ship built-in recipes, accept Source-declared recipes, or rewrite user recipes. See [ADR 0007](docs/adr/0007-delegate-app-lifecycle-to-user-recipes.md).

Recipes live in an environment-local per-user `apps/` directory beside `sources.json`. Private atomic approval receipts live in sibling `app-approvals/`, keyed on canonical recipe path and exact content hash; CLI approval is only `app approve <name> --yes`, not `app validate`. WSL manages Linux only and skips Windows drive PATH candidates. Installed-App records use atomic per-App JSON files in sibling `app-installations/`. Project-scoped Apps and per-project steps are excluded. Uninstall does not implicitly run teardown; user-global update selection uses repeatable `--app <name>` alongside `--skill`, or `--all` for both (see `.scratch/apps/spec.md`).

## Packages and ownership

Packages are host-native bundles discovered inside a registered Source, with per-host identity and per-host command grammar. The `package-model.ts`, `package-bundles.ts`, `package-host-plans.ts`, `package-host-state.ts`, `package-content.ts`, `package-state.ts`, and `package-flow.ts` modules parse manifests and host state into domain types at the boundary, derive host argv from frozen templates rather than pasted strings, and record only the selection and the receipt. This is explicit logic and frozen tables, not a generic plugin framework: the no-generic-plugin-framework line below stays true.

Three owners never overlap: the Source snapshot owns what a bundle is (manifest bytes, component inventory, declared version); the host CLI owns installed state, which Agent Depot reads from `~/.pi/agent/settings.json` and `~/.claude/plugins/installed_plugins.json` and never writes; Agent Depot owns the selection record in one locked atomic `packages.json` and the approval receipt in `package-approvals/<digest>.json`, keyed on a digest of the derived declaration. Installed version comes from the host, so `unknown` is a first-class status. A bundle's own skills never become a second managed copy: no `package-*` module imports the Skill install engine, and a test asserts that edge. See [ADR 0009](docs/adr/0009-delegate-package-lifecycle-to-host-clis.md) and `.scratch/packages/design.md`.

## Testing seam

Application operations receive an injectable command runner. Tests can assert the executable and argument list without invoking a shell or external process. Filesystem-dependent tests use isolated temporary directories for the project manifest, per-user state, and simulated host/skill locations.

## Deliberate V1 exclusions

V1 explicitly rejects:

- a monorepo or multiple packages;
- a database; JSON files are sufficient for the project manifest and per-user state;
- a generalized plugin framework; supported skill, App, and Package logic stays explicit;
- agent definitions and MCP servers as independently managed V1 categories;
- built-in or Source-declared App recipes, cloning App repositories, tracking App-written artifacts, and editing Host configuration on an App's behalf;
- project-scoped Apps, per-project App steps, and executing manual shell strings;
- per-OS skill-method command variants; skill methods are one portable executable-plus-args definition. App recipes may be platform-specific.

## Open technical questions

1. What exact schemas should `agent-depot.json` and the per-user JSON state file use?
2. What minimum Node.js version, package name, and package availability/registry policy are required?
3. Which standard per-user configuration paths should Linux and Windows use, and how should migration and purge work?
4. Automatic discovery excludes explicitly lifecycle-marked subtrees, with examples including `in-progress`, `beta`, `deprecated`, and `retired`, without deleting or modifying source content. Which exact markers belong in that set, whether explicit path addition overrides the scan filter, and which other scan exclusions should apply (including ignored, generated, or vendor directories and symlinks) remain open, as do duplicate skill-name handling, collision behavior, and edge validation rules for the required `SKILL.md` name and description metadata/frontmatter. Source-scan exclusion must not silently select or install anything.
5. The exact Windows symlink creation mechanics and required runtime validation remain implementation/check prerequisites. The resolved failure behavior is to stop the target operation with actionable guidance when symlink creation fails, including on Windows, without creating a duplicate managed copy. How should adoption compare content and guide resolution of same-name conflicts?
6. How is version availability detected for skills, including built-in skills and sources without reliable version metadata?
7. What CLI grammar, prompts, exit statuses, and user-facing error format should the operations expose?


App lifecycle commands are non-interactive: stdin is ignored (EOF), as in the
existing Skill command runner, and there is no execution timeout. Recipes must
use non-interactive flags; installers requiring a terminal belong in `manual`
steps. EOF lets stdin-based prompts fail rather than wait for input, but a
process ignoring EOF can still hang; cancel it manually. Captured App stdout
and stderr are each capped at 1 MiB; failures show only their last 4 KiB.

## Portable user-global Profiles

A Profile captures Git Sources and discovery inclusion, user-global managed Skill
selections with recorded Hosts/version policies/methods, and full App recipes.
`agent-depot export [--out <file>]` exports strict `agent-depot-profile/v1` JSON;
block exclusions and repeated Source/Skill/App filters select independently.
Local paths, credentials, unmanaged/App-owned Skills, project selections,
installation evidence, caches, approvals and installed-App state do not travel.
Core parsing reuses portable manifest and App recipe validation.

Add-only import and the fifth **5 Import/Export** TUI tab are approved follow-up
work: conflicts are skipped, existing choices never change, recipes arrive
unapproved and Apps are never installed by import. This tab is the explicit
exception to the existing no-new-tabs direction; App lifecycle stays in existing
views. See [ADR 0008](docs/adr/0008-portable-user-global-profiles.md) and
[the Profile spec](.scratch/profile/spec.md).
