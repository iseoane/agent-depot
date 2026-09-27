# Agent Depot — Minimal Technical Design

**Status:** Minimal V1 architecture approved; implementation details remain open.

## Architecture

Agent Depot is one TypeScript/Node.js package, with pnpm preferred and npm-compatible package metadata. The CLI is the first interface. A future TUI must call the same terminal-independent application operations rather than implement a second workflow. V1 supports Linux and Windows.

V1 manages only portable directory-based skills as the confirmed resource type. Each managed skill is a portable directory containing `SKILL.md` with required `name` and `description` metadata, optionally with supporting files. Pi-only standalone Markdown skill files are not managed. CLI applications, agent definitions, plugins/extensions, and MCP servers are deferred and not committed to V1.

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

CLI (and future TUI) ───────> the same application operations
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

Before any external command runs, Agent Depot renders the executable and arguments, the intended host/scope/skill changes, and requests explicit confirmation. Uninstallation also requires confirmation.

## Testing seam

Application operations receive an injectable command runner. Tests can assert the executable and argument list without invoking a shell or external process. Filesystem-dependent tests use isolated temporary directories for the project manifest, per-user state, and simulated host/skill locations.

## Deliberate V1 exclusions

V1 explicitly rejects:

- a monorepo or multiple packages;
- a database; JSON files are sufficient for the project manifest and per-user state;
- a generalized plugin framework; supported skill logic stays explicit;
- CLI applications, agent definitions, plugins/extensions, and MCP servers as managed V1 categories;
- per-OS command variants; commands are one portable executable-plus-args definition.

## Open technical questions

1. What exact schemas should `agent-depot.json` and the per-user JSON state file use?
2. What minimum Node.js version, package name, and package availability/registry policy are required?
3. Which standard per-user configuration paths should Linux and Windows use, and how should migration and purge work?
4. Automatic discovery excludes explicitly lifecycle-marked subtrees, with examples including `in-progress`, `beta`, `deprecated`, and `retired`, without deleting or modifying source content. Which exact markers belong in that set, whether explicit path addition overrides the scan filter, and which other scan exclusions should apply (including ignored, generated, or vendor directories and symlinks) remain open, as do duplicate skill-name handling, collision behavior, and edge validation rules for the required `SKILL.md` name and description metadata/frontmatter. Source-scan exclusion must not silently select or install anything.
5. The exact Windows symlink creation mechanics and required runtime validation remain implementation/check prerequisites. The resolved failure behavior is to stop the target operation with actionable guidance when symlink creation fails, including on Windows, without creating a duplicate managed copy. How should adoption compare content and guide resolution of same-name conflicts?
6. How is version availability detected for skills, including built-in skills and sources without reliable version metadata?
7. What CLI grammar, prompts, exit statuses, and user-facing error format should the operations expose?
