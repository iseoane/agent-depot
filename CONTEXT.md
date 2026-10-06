# Resource Manager

This context defines the product language for discovering, installing, and updating reusable skills across supported coding-agent hosts and user-global Apps.

## Language

**Profile**:
A portable collection of user-global Source discovery choices, managed Skill selections and App recipes that can be exported and added on another machine without replacing existing choices or transferring approvals or installed state.
_Avoid_: Backup, sync (a Profile transfers choices, not machine state)

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
An item selected for installation and ongoing tracking. V1 manages portable directory-based skills, user-global Apps, and host-native Packages; agent definitions and MCP servers remain deferred as independently managed categories.

**Resource category**:
A classification of a managed resource. Skill, App, and Package are confirmed V1 categories; agent definition and MCP server remain deferred categories for future scope decisions.

**App**:
A user-global application whose install, update, uninstall, and optional per-Host setup and teardown are delegated to a user-declared App recipe. An App owns any artifacts it creates, including skills or Host configuration; Agent Depot tracks its installed version, not those artifacts.
_Avoid_: CLI application, Host resource (for an App)

**App recipe**:
A user-owned declaration of an App's lifecycle commands and version signals, optionally specific to a platform. It is not a Source resource or a built-in recipe.
_Avoid_: Installation method (for the whole App recipe)

**Package**:
A host-native bundle discovered inside a registered Source: a Pi package that declares a `pi` manifest key, a `pi-package` keyword, or a Pi-specific conventional resource directory, or a Claude Code plugin with a `.claude-plugin/plugin.json` bound by an in-repo marketplace. Its lifecycle is delegated to the host CLI, and its installed state is read from the host's own state files, never written by Agent Depot.
_Avoid_: npm package (unless it specifically means the npm distribution channel)

**Bundle**:
The unit a Package manages: a manifest plus its declared components and version, discovered as one descriptor per host format. A dual-format repository such as pstack-claude yields one Pi descriptor and one Claude descriptor over the same skills directory.

**Component inventory**:
The typed list of what a bundle provides, read from its manifest at the boundary: each component carries a kind, an ownership (`skill-category` or `host-only`), an effect, and its declared paths. Agent definitions and MCP servers surface here as `host-only` components and stay deferred.

**Marketplace binding**:
The in-repo `.claude-plugin/marketplace.json` entry that names a Claude plugin and its source. A Claude Package is installable only through such a binding; a plugin with no in-repo marketplace binding is reported but not installable.

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
