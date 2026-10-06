# Delegate Package lifecycle to the host CLI

Status: Accepted (2026-10-05)

## Context

Coding-agent capabilities increasingly ship as host-native bundles rather than loose skills. A Pi package is a directory or npm package whose `package.json` declares skills, extensions, prompts, and themes, installed by `pi install`. A Claude Code plugin is a directory with a `.claude-plugin/plugin.json` manifest, installed from a `.claude-plugin/marketplace.json` marketplace by `claude plugin install`. One repository can be both, as pstack-claude is.

Agent Depot already manages portable directory-based Skills and user-global Apps. A user who wants a bundle has three bad options: register the repository as a Source and get only its skills, losing the agents, hooks, and extensions those skills reference; write an App recipe per host by hand, duplicating what the host CLI already does; or install the bundle outside Agent Depot and get no version tracking. A bundle's skills are not separable in practice, because they reference plugin agents and extension-provided tools.

The category needs an ownership boundary, because the truth owner differs from Apps: an App recipe is user-authored, while a Package's commands are derived from a manifest Agent Depot reads, and its installed state lives in host-owned files Agent Depot must not write.

## Decision

Promote **Package** to a supported resource category for host-native bundles. Agent Depot reads the bundle's own manifest into a typed component inventory, generates the host CLI commands from the typed declaration rather than a pasted string, runs them through the injectable no-shell command runner after approval, and reads installed state back from the host's own state files.

Three owners, with no overlap:

- The **Source snapshot** owns what a bundle is: its manifest bytes, its component inventory, and its declared version.
- The **host CLI** owns installed state. Agent Depot reads `~/.pi/agent/settings.json` and `~/.claude/plugins/installed_plugins.json` as evidence and never writes them.
- **Agent Depot** owns the selection record and the receipt for what it delegated.

Commands are derived, never pasted, so nothing user-authored reaches the runner and the safety property is structural. Approval is a content-keyed receipt plus a per-run confirmation; the receipt is keyed on a digest of the derived declaration (source, ref, coordinates, manifest digest, and the exact ordered argv) rather than on a user-authored recipe file.

Installed version comes from the host, so `unknown` is a first-class status and is never rendered as `current`. A plan declares its blast radius rather than assuming a command touches one bundle, because a host-wide verb is one line away.

A bundle that carries agent definitions or MCP servers reports them as `host-only` components and lets the host own them wholly; Agent Depot never adopts, removes, names, updates, or configures them. A bundle's own skills never become a second managed copy: the canonical `~/.agents/skills` location and the Claude symlink stay under the Skill engine, no `package-*` module imports that engine, and a test asserts the import edge is absent. No file under a Host skill root is created, changed, or removed.

V1 hosts are Pi and Claude Code. V1 bundle sources are a Git repository scoped to its root for Pi and a marketplace bound inside the same repository for Claude. Codex and OpenCode plugins and npm-sourced Pi packages stay recognized but deferred.

## Consequences

- Pi identity is the repository URL without the ref; a git tag or commit pin is pinned, and `pi update <source>` reconciles that one checkout while `pi update --extensions` updates every configured package. A Pi package below the Source scope root and a scoped GitHub Source URL are refused rather than guessed.
- A Claude selection carries `marketplaceRoot` and `pluginName` together, so a plugin cannot be named without its marketplace, and a plugin with no in-repo marketplace binding is reported but not installable.
- Agent Depot cannot verify installed state for an unversioned Pi git package and reports `unknown` instead of guessing; a bundle already installed by hand through an App recipe is recognized from the host's state files and runs no host command.
- The Package category adds explicit logic and frozen argv tables, not a generic plugin framework, keeping the DESIGN.md veto in force.
- Deferred scope is unchanged in kind: agent definitions and MCP servers as independently managed categories, Codex and OpenCode packaging, npm-sourced Pi packages, Pi per-resource narrowing, project-scoped Packages, and external Claude marketplace sources.

## Amendment: ownership is active-only (2026-10-06)

The original decision read ownership structurally, so every discovered descriptor owned its declared Skills whether or not the user selected it and whether or not it was installable. Issue 21 surfaced the cost on `mattpocock/skills`, an ordinary skill repository that also declares a Claude plugin. Its 27 declared Skills were dimmed and refused as portable installs even though no one had chosen the bundle. The user settled the fork in favor of the reported reading.

A Package now owns its declared Skills only while it is **active**:

- the user selected it, so a record in `packages.json` names it, or
- a host state file proves it installed, with `findInstalledBundle` returning `installed`.

The Source, host, and coordinates must all agree, so a selection or install for another Source is not ownership. A descriptor that is not installable never owns. A host state file that cannot be read, or a record whose shape cannot be decoded, yields `unknown`, which is not `installed`, so it never falsely reserves a Skill; the user's own selection still does. The descriptor's installability is now a typed field rather than text parsed out of a warning.

The complementary direction is a refusal. Selecting or installing a Package whose declared Skills already exist as managed portable user-global installations fails with an actionable conflict naming the portable paths. Nothing is uninstalled, replaced, or written; the user forgets the portable installations first.

`activeBundles` in `src/package-owned-skills.ts` is the one classifier. It reuses the descriptors from the snapshot pass the guard already reads, so there is no second walk. The guard, the unmanaged inventory, the CLI install and uninstall paths, and the Catalog tree all consume its output.
