# Resource Manager

This context defines the product language for discovering, installing, and updating reusable agent resources and applications across supported coding-agent hosts.

## Language

**Host**:
A coding-agent environment in which a managed resource can be made available. Initial hosts are Pi, Claude Code, Codex, and OpenCode.
_Avoid_: Platform, target agent (when referring to the installed environment)

**Source**:
An upstream repository or location registered as a place to discover managed resources. A source may contain multiple resources; registering it does not itself select those resources for management.
_Avoid_: Catalog (the collection, not an individual origin)

**Catalog**:
The user's collection of registered sources and selected or installed managed resources. A managed resource remains in the catalog while installed, even if its source is removed.
_Avoid_: Registry (unless referring to an external registry)

**Managed resource**:
An item selected for installation and ongoing tracking. Initial categories include skills, agents, plugins/extensions, MCP servers, and CLI applications; resources may come from the project's own collection or external sources.
_Avoid_: Package (unless it specifically means an npm package)

**Resource category**:
A classification of a managed resource—such as skill, agent, plugin/extension, MCP server, or CLI application—that identifies its kind and informs host compatibility and its management method.

**Skill**:
A reusable, primarily instruction-based capability distributed as a directory containing `SKILL.md` and optionally supporting files such as references, scripts, and assets.
_Avoid_: Prompt (for a reusable installed skill)

**Installation method**:
The procedure used to install or update a resource, taken from its upstream project or provided by the user. The applicable method depends on the resource and its category.

**Installation**:
A managed resource made available for a specific host and scope. Installations of the same resource in different scopes are independent and may have different versions.

**Installation scope**:
Where an installation is available: project-scoped or user-global. The selected scope must be explicit in automation and may be prompted for in interactive use.
_Avoid_: Environment (ambiguous with runtime environment)

**Version policy**:
The chosen version target for an installation: a fixed version or the latest available version.
_Avoid_: Version (when the policy, rather than the installed version, is meant)

**Update batch**:
A single review of installed resources with newer versions available, presented together so the user can choose to update all or a selected subset using each resource's applicable method.
_Avoid_: Per-resource update prompt
