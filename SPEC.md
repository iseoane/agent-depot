# Agent Depot — Product Specification

**Status:** Draft — product scope and delivery constraints captured; technical design remains open.

Agent Depot is a cross-platform CLI for discovering, selecting, installing, updating, and removing reusable coding-agent resources and applications. It manages resources from user-owned or external sources across projects and user-global installations.

## V1 at a glance

| Decision | V1 direction |
|---|---|
| Interface | CLI first; a TUI may follow later. |
| Runtime | TypeScript on Node.js. Minimum supported Node.js version is open. |
| Package workflow | pnpm preferred; retain npm compatibility. |
| Invocation | Support `pnpm dlx` and `npx`, plus persistent global installation. |
| Platforms | Linux and Windows. |
| Hosts | Pi, Claude Code, Codex, and OpenCode. The user chooses compatible hosts for each operation. |
| Source catalog | Sources are registered globally and reusable across projects. |
| Project selection | A versionable project manifest records selected resources and version policies. It contains enough source and resource identity to resolve on a fresh machine. |
| Install scopes | Project and user-global installations are independent, including their installed-version state. |

## Core concepts

- **Source:** An upstream repository or location from which resources can be discovered. Registering a source does not select every resource it contains.
- **Managed resource:** A selected item that Agent Depot tracks for installation and updates. Initial categories are skills, agents, plugins/extensions, MCP servers, and CLI applications.
- **Resource category:** A resource classification that informs host compatibility and the appropriate management method. Use clear upstream metadata; ask the user when category information is absent or ambiguous.
- **Installation method:** The official upstream method or a user-provided method for installing or updating a resource.
- **Project manifest:** A versionable project file identifying selected resources, their source URLs/resource identities, and version policies. It must be usable without first registering those sources in the current user's global catalog.
- **User catalog:** The user's globally reusable source list and managed-resource records. `pnpm dlx`, `npx`, and the globally installed CLI share this state.
- **Installation scope:** Either project-scoped or user-global. The same resource installed in both scopes is tracked as two independent installations.

## Requirements

### Discover and select

1. Users can register an upstream source by URL and discover resources within it, or add a specific resource directly. Both paths may be used together.
2. Users can manage resources from this project's own collection as well as external sources.
3. Registering a source alone does not enroll all of its resources in `all`; only resources selected for management are eligible.
4. The initial managed-resource categories are skills, agents, plugins/extensions, MCP servers, and CLI applications.
5. When category or resource identity cannot be determined reliably from source metadata, Agent Depot asks the user rather than silently guessing.

### Install and track

6. Users can install selected resources for an explicitly chosen host set and either project or user-global scope. Automation requires an explicit scope; interactive operation may prompt for it.
7. `all` means all selected resources compatible with the chosen hosts and scope; it never means all content in every registered repository.
8. A project manifest stores the selected resources and their version policies, including enough source URL and resource identity to resolve them after cloning on a machine with an empty global catalog.
9. Project and user-global installations maintain independent state and installed versions.
10. Agent Depot uses each resource's applicable upstream installation method when available and allows a user-provided method as an alternative.
11. Before executing an external command supplied by a user or resource source, Agent Depot shows what will run and requires explicit confirmation.

### Check and apply updates

12. Users can select a fixed version or `latest` as the version policy for a resource installation.
13. Agent Depot checks installed resources for a newer version and presents available updates together, rather than prompting one resource at a time. If version status cannot be determined, it reports the status as unknown and does not present the resource as an available update.
14. From that batch, users can choose to update all available resources or a selected subset. Updates use each resource's applicable method and respect its configured version policy. If an independent resource update fails, Agent Depot continues with the remaining selected resources and summarizes successes and failures.
15. `pnpm dlx`, `npx`, and a persistent global installation use the same user catalog/configuration, so changing invocation mode does not create a second inventory.
16. Updating or removing Agent Depot itself is delegated to the package manager used to install the persistent CLI; Agent Depot does not require a separate self-updater.

### Remove sources, resources, and Agent Depot

17. Removing a registered source does not uninstall its resources automatically.
18. When removing a source, Agent Depot lists dependent resources that remain installed and lets the user keep all, uninstall selected resources, or uninstall all. Installed resources kept after source removal remain tracked in the catalog; updates can resume if the source is registered again or another method is configured.
19. Resource uninstallation requires explicit confirmation.
20. When uninstalling Agent Depot, the user can independently choose whether to remove the persistent CLI, managed resources, and catalog/configuration data. The default is to preserve managed resources and catalog/configuration data.

## Acceptance checks

- Registering a repository exposes its discoverable resources without silently selecting all of them.
- A selected resource can be installed for a chosen compatible host and project/global scope.
- A project manifest can resolve its selected resources on another machine without pre-registering its source URLs globally.
- `all` affects only selected resources compatible with the chosen hosts and scope.
- An update check presents all available newer versions together and allows all-or-subset selection; resources whose version status is unknown are identified separately, not treated as updateable.
- Removing a source preserves installed dependents unless the user selects them for uninstall.
- If one selected resource fails to update, independent selected updates still proceed and the final summary identifies the failures.
- Invocations via `pnpm dlx`, `npx`, and the global CLI observe the same user catalog/configuration.
- Uninstalling Agent Depot preserves resources and user data by default and asks separately about each removal category.
- The CLI works on Linux and Windows for the supported V1 resource/host combinations.

## Explicitly later or out of scope for V1

- A TUI; the initial interface is a CLI.
- Silent execution of third-party commands.
- Automatically enrolling every resource from a registered source in `all`.
- Agent Depot implementing its own update mechanism instead of relying on the package manager.

## Open design decisions

These do not block the functional direction above, but must be resolved before implementation:

1. Minimum supported Node.js version and package name/registry publication details.
2. Project manifest filename, schema, and how it represents resource identity and version targets.
3. Per-user catalog/configuration paths on Linux and Windows, plus data migration and purge behavior.
4. Per-host and per-category compatibility detection and installation/update adapters.
5. How version availability is determined for resources whose upstream methods do not expose a standard version.
6. CLI command grammar, prompts, error handling, and behavior when a batch partially fails.
