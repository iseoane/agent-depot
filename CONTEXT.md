# Resource Manager

This context defines the product language for discovering, installing, and updating reusable skills across supported coding-agent hosts.

## Language

**Host**:
A coding-agent environment in which a managed skill can be made available. Initial hosts are Pi, Claude Code, Codex, and OpenCode.
_Avoid_: Platform, target agent (when referring to the installed environment)

**Source**:
An origin from which managed skills are discovered, including Agent Depot's own collection and external repositories or locations registered by the user.
_Avoid_: Catalog (the collection, not an individual origin)

**Catalog**:
The user's collection of available sources and selected or installed managed skills. A managed skill remains in the catalog while installed, even if its source is removed.
_Avoid_: Registry (unless referring to an external registry)

**Managed resource**:
An item selected for installation and ongoing tracking. V1 manages only portable directory-based skills; CLI applications, agent definitions, plugins/extensions, and MCP servers are deferred categories.
_Avoid_: Package (unless it specifically means an npm package)

**Resource category**:
A classification of a managed resource. Skill is the only confirmed V1 category; CLI application, agent definition, plugin/extension, and MCP server are deferred categories for future scope decisions.

**CLI application**:
A future resource concept for an executable or command-line tool managed independently of a coding-agent host. It is not part of V1.
_Avoid_: Host resource (for a CLI application)

**Skill**:
A reusable, primarily instruction-based capability distributed as a portable directory containing `SKILL.md` with required `name` and `description` metadata, and optionally supporting files such as references, scripts, and assets.
_Avoid_: Prompt (for a reusable installed skill)

**Adoption**:
The act of bringing an existing skill installation under tracking without replacing or moving it when its content exactly matches the selected source; its existing location remains tracked. Exposing it to an additional host location later requires explicit confirmation.
_Avoid_: Import (when referring to tracking an existing installation)

**Unmanaged skill**:
A skill directory or symlink found in a user-global skill root that Agent Depot has no installation record for. It is reported but never updated or looked up through a Source. It can be adopted (brought under tracking when it exactly matches a Source) or removed by explicit path; removing it deletes only what was listed in the preview and never follows a symlink to its target.
_Avoid_: Orphan, untracked install; Adoption (that is tracking an unmanaged skill, not the skill itself)

**Installation method**:
The procedure used to install or update a skill, taken from its upstream project or provided by the user.

**Installation**:
A managed skill made available to a selected host and scope. Installations of the same skill in different scopes are independent and may have different versions.

**Host exposure**:
Making an installed skill available to a Host, or withdrawing it, without changing its content or version. Adding Hosts to an installation needs an explicit additional-host confirmation; removing some Hosts keeps the installation, and removing the last one is a full removal.
_Avoid_: Reinstall (exposure never copies or re-resolves content)

**Canonical location**:
The one directory that holds an installed skill's files for user-global use: `~/.agents/skills/<skill>`, shared by the Pi, Codex, and OpenCode Hosts. Claude Code is exposed through a managed symlink to it. Removal keeps the canonical location while any Host still uses it.
_Avoid_: Primary copy, master copy

**Built-in source**:
The Source shipped with Agent Depot (`builtin:agent-depot`). It is fixed: it cannot be refreshed, removed, or migrated.
_Avoid_: Default source

**Refresh before preview**:
For any operation that can write, the Source is refreshed before the preview is shown, so the content the user confirms is exactly the content that is applied.
_Avoid_: Refresh on confirm

**Installation scope**:
Where an installation is available: project-scoped or user-global. The selected scope must be explicit in automation and may be prompted for in interactive use.
_Avoid_: Environment (ambiguous with runtime environment)

**Version policy**:
The chosen version target for an installation: a fixed version or the latest available version.
_Avoid_: Version (when the policy, rather than the installed version, is meant)

**Removal scope**:
Uninstalling is supported for user-global installations only. Project installations can be listed and updated, but removing them is out of scope for now.

**Update batch**:
A single review of installed skills with newer versions available, presented together so the user can choose to update all or a selected subset using each skill's applicable method.
_Avoid_: Per-resource update prompt
