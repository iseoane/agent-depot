# Agent Depot V1

Status: ready-for-agent

## Problem Statement

Users manage reusable coding-agent capabilities across multiple hosts, projects, and user-global installations, but the existing workflows are fragmented. A source may contain several skills, host discovery paths differ, and a project needs a versionable record that can be resolved on another machine. Users need a small cross-platform CLI that can discover, select, install, update, and remove portable directory-based skills without silently selecting unrelated source content or overwriting existing installations.

Agent Depot V1 is deliberately limited to the confirmed `Skill` resource category. CLI applications, agent definitions, plugins/extensions, and MCP servers are deferred. A skill is a portable directory containing `SKILL.md` with required `name` and `description` metadata, optionally accompanied by supporting files. Pi-only standalone Markdown skill files are not managed in V1.

## Solution

Build one TypeScript/Node.js package with a CLI-first interface, pnpm preferred and npm-compatible. It supports Linux and Windows, `pnpm dlx`, `npx`, and persistent global installation. A future TUI uses the same terminal-independent application operations as the CLI.

Agent Depot provides these capabilities:

- Register external sources by URL and use the built-in first-party collection without external registration.
- Recursively discover recognized portable skill directories without selecting all discovered skills automatically.
- Exclude explicitly lifecycle-marked subtrees from ordinary automatic candidate results. Examples include `in-progress`, `beta`, `deprecated`, and `retired`; source content is not deleted or modified.
- Let users add a specific skill/path when normal discovery cannot identify a supported skill, without treating an unsupported format as a supported V1 skill.
- Select compatible skills for an explicit project or user-global installation scope and host set.
- Use `.agents/skills` and `~/.agents/skills` as the canonical new installation paths. When Claude Code is selected, expose the canonical directory through a symlink under `.claude/skills` or `~/.claude/skills`.
- Adopt an exactly matching pre-existing installation in place, including one at a noncanonical location, and track its actual location. Moving it or exposing it at another host location requires explicit confirmation.
- Store project selections in a versionable `agent-depot.json` and store reusable sources and user-global installation state in one per-user JSON file shared by all invocation modes.
- Check versions and present an `Update batch` so users can update all or a selected subset. Unknown version status is not treated as updateable, and independent update failures do not stop the remaining selected updates.
- Require explicit confirmation before executing external commands or uninstalling skills.
- Remove sources without automatically uninstalling dependent skills, and make Agent Depot self-uninstallation choices independently selectable while preserving managed skills and user data by default.

The architecture stays explicit and small: CLI rendering and prompts sit above terminal-independent application operations; resource logic handles source discovery, skill identity, format recognition, host compatibility, version checks, and installation-method selection; persistence and adapters isolate JSON files, source access, filesystem/host paths, and command execution.

## User Stories

1. As a user, I can register an upstream source by URL so that I can discover its portable skills.
2. As a user, I can use Agent Depot's built-in first-party skills without registering an external source.
3. As a user, I can recursively inspect a source and see only recognized portable skill directories whose `SKILL.md` has the required `name` and `description` metadata.
4. As a user, I do not have lifecycle-marked subtrees such as `in-progress`, `beta`, `deprecated`, or `retired` presented as ordinary automatic discovery candidates, while the source content remains untouched.
5. As a user, I can provide an explicit skill/path when automatic discovery cannot recognize a source, without causing an unsupported file format to become a supported V1 skill.
6. As a user, I can register a source without automatically selecting every skill it contains.
7. As a user, I can select a skill from the Catalog for a specific compatible Host and an explicit project or user-global Installation scope.
8. As a user, I can use `all` to mean all selected skills compatible with the chosen hosts and scope, rather than all source content.
9. As a user, I can see why a selected skill is incompatible with a chosen Host, and the incompatible skill is excluded from `all` and not installed for that Host.
10. As a user, I can install a new project-scoped skill under `.agents/skills` or a new user-global skill under `~/.agents/skills`, regardless of whether Claude Code is the only selected Host.
11. As a user selecting Claude Code, I can have a symlink under `.claude/skills` or `~/.claude/skills` expose the canonical skill directory without Agent Depot claiming that Claude Code natively scans `.agents/skills`.
12. As a user, I receive actionable guidance and no duplicate managed copy when a required Claude Code symlink cannot be created, including on Windows.
13. As a user, I can adopt an exactly matching existing skill without reinstalling, replacing, or moving it, and Agent Depot tracks its actual location.
14. As a user, I am asked for explicit confirmation before Agent Depot moves an adopted skill or creates an additional host-location link or copy.
15. As a user, I can resolve a project on a fresh machine from its `agent-depot.json` without first registering its sources in the current user's global Catalog.
16. As a user, I can choose a fixed version or `latest` as the Version policy for each skill Installation.
17. As a user, I can review all available skill updates together and update all or a selected subset in one Update batch.
18. As a user, I can see unknown version status separately from available updates, so an unreliable version signal is not presented as an update.
19. As a user, I can rely on built-in skill versions following the Agent Depot package version while installed copies change only through the normal Update batch.
20. As a user, I can rely on an independent failed skill update not preventing the remaining selected updates from running, with a final summary of successes and failures.
21. As a user, I can invoke Agent Depot through `pnpm dlx`, `npx`, or the persistent global CLI and see the same per-user Catalog and configuration state.
22. As a user, I can remove a Source without automatically uninstalling its dependent skills, then choose whether to keep or uninstall selected dependents.
23. As a user, I must explicitly confirm skill uninstallation.
24. As a user uninstalling Agent Depot, I can independently choose whether to remove the persistent CLI, managed skills, and Catalog/configuration data, with managed skills and user data preserved by default.
25. As a maintainer, I can add a future TUI over the same terminal-independent application operations instead of implementing a second workflow.
26. As a maintainer, I can test application behavior through observable plans, results, and filesystem effects without invoking a terminal UI, real host paths, external commands, or network access.

## Implementation Decisions

1. V1 manages only portable directory-based `Skill` resources. CLI applications, agent definitions, plugins/extensions, and MCP servers are deferred resource categories and must not be added to V1 through implementation shortcuts.
2. The initial interface is a CLI. A TUI is later work and must reuse the same highest-level application operations.
3. Supported platforms are Linux and Windows. The minimum Node.js version, package name, and publication details remain implementation work.
4. New project-scoped installations use `.agents/skills`; new user-global installations use `~/.agents/skills`. A selected Claude Code Host also receives a symlink entry under `.claude/skills` or `~/.claude/skills` pointing at the canonical directory.
5. If symlink creation fails, the target operation stops with actionable guidance and does not create a duplicate managed copy. The exact Windows mechanics and runtime validation remain implementation work.
6. An exactly matching pre-existing skill is adopted in place and its actual location is tracked. Different content with the same name is a conflict and is not overwritten without explicit confirmation.
7. The project manifest is `agent-depot.json` at the project root. The per-user JSON state file stores globally reusable Sources, user-global managed-skill records, and user-global user-provided methods. Project and user-global Installations remain independent.
8. A project manifest contains enough Source and skill/path identity to resolve selections on a fresh machine. Optional user-provided install/update commands are stored with the relevant project or user-global record, contain no secrets, have no OS-specific variants, and require preview plus explicit confirmation before execution.
9. All invocation modes share one per-user Catalog/configuration file. Updating or removing the persistent Agent Depot CLI is delegated to the package manager used to install it; Agent Depot does not require a separate self-updater.
10. Automatic discovery excludes explicitly lifecycle-marked subtrees from ordinary candidate results and never deletes or modifies source content. The exact marker set and whether explicit path addition overrides the scan filter are open implementation details. Exclusion must not silently select or install anything.
11. Other recursive scan exclusions, duplicate skill-name handling, collision behavior, required metadata edge validation, Host compatibility detection, installation/update methods, version signals, configuration paths, schemas, CLI grammar, prompts, exit statuses, and reporting format remain technical decisions for implementation tickets.
12. The supplied repositories are reference material only. They are not default Agent Depot Sources, default project selections, or managed V1 resources; their lifecycle behavior does not expand V1.

## Testing Decisions

1. Test the highest-level terminal-independent application operations used by the CLI and future TUI. The tests should exercise observable application behavior rather than private implementation details.
2. Isolate Source access, filesystem and Host paths, and command execution behind replaceable dependencies. Tests use fakes for those boundaries and injectable command runners rather than invoking a shell or real external commands.
3. Use temporary directories to assert project-manifest, per-user-state, canonical skill-path, symlink, adoption, conflict, and uninstall filesystem effects. Assert returned plans and results, including compatibility reasons, confirmation requirements, update-batch continuation, and failure summaries.
4. Tests must not require network access or depend on a checked-out external repository. Small representative fixtures may reflect relevant source layouts, including lifecycle-marked subtrees, but entire external repositories must not be vendored.
5. There is no prior Agent Depot test code. This artifact does not claim that implementation or tests already exist, and runtime validation has not been performed.

## Out of Scope

- A TUI for V1; the initial interface is CLI-only.
- CLI applications, agent definitions, plugins/extensions, and MCP servers as managed V1 resource categories.
- Pi-only standalone Markdown skill files.
- Silent execution of third-party or user-provided commands.
- Automatically enrolling every Skill from a registered Source in `all`.
- A separate Agent Depot self-updater instead of package-manager lifecycle handling.
- Treating the supplied `mattpocock/skills`, `Gentleman-Programming/engram`, or `colbymchenry/codegraph` repositories as default Sources, default project selections, or vendored test dependencies.
- Deleting source content when automatic discovery excludes lifecycle-marked subtrees.

## Further Notes

This specification records the functionally closed V1 direction and the approved testing seam. It does not claim code, package metadata, tests, or runtime validation. Implementation tickets still need to resolve the exact JSON schemas, per-user configuration paths and migration behavior, Node.js minimum, package metadata, lifecycle marker set, explicit-path override behavior, additional scan exclusions, symlink mechanics and Windows validation, metadata edge cases, duplicate and conflict handling, Host compatibility and installation methods, version signals, command grammar, prompts, exit statuses, and reporting format. Those details must preserve the scope and behaviors stated here and in the canonical `SPEC.md` and `DESIGN.md` documents.

The supplied repositories were reviewed as external references, not as default Sources or vendored test dependencies:

- [`mattpocock/skills`](https://github.com/mattpocock/skills): its README describes editable skill copies and `npx skills update`, plus automatic updates through its Claude marketplace plugin. The repository's `skills/in-progress/README.md` says these beta skills are public, omitted from the plugin/top-level README, and may change or disappear without warning; its deprecated bucket is currently documented as empty. This exposed the lifecycle-subtree discovery case.
- [`Gentleman-Programming/engram`](https://github.com/Gentleman-Programming/engram): the CLI checks for a newer GitHub release and prints package-manager/release update guidance, while installation paths include Homebrew, Go installation, and release binaries. Its top-level command dispatch has no general application `upgrade` or `uninstall` command; `engram setup` covers agent integrations separately.
- [`colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph): its CLI and tests cover `upgrade` and `uninstall`, while separating global agent integration/binary removal from per-project `init`/`uninit` state. Those application-management behaviors remain outside Agent Depot V1.
