# Packages: host-native bundles as a managed category

Status: needs-triage

## Problem Statement

Coding-agent capabilities increasingly ship as host-native bundles rather than as
loose skills. A Pi package is a directory or npm package with a `package.json`
that declares skills, extensions, prompts, and themes, installed by
`pi install`. A Claude Code plugin is a directory with a
`.claude-plugin/plugin.json` manifest that bundles skills, agents, hooks, MCP
servers, commands, and more, installed from a `.claude-plugin/marketplace.json`
marketplace by `claude plugin install`. One repository can be both, as
`pstack-claude` is.

Agent Depot manages portable directory-based Skills and user-global Apps. It
defers plugins and extensions. A user who wants a bundle today has three bad
options. Register the repository as a Source and get only its skills, losing the
agents, hooks, and extensions the skills reference. Write an App recipe per Host
by hand, which duplicates what the Host CLI already does and cannot vary the
lifecycle step by Host. Or install the bundle outside Agent Depot and get no
version tracking at all.

The gap matters because a bundle's skills are not separable from the rest of the
bundle in practice. The pstack skills name `pstack:poteto-agent` and
`pstack:comment-sicko`, which are agents the Claude plugin provides, and the Pi
extension supplies the `agent`, `send_message`, and `schedule_wakeup` tools that
those skills need. Installing only the skills produces a broken half.

## Solution

Add **Package** as a confirmed resource category for host-native bundles. A
Package is discovered inside a registered Source. Agent Depot reads the bundle's
own manifest into a typed component inventory, generates the host CLI commands
from the typed declaration rather than from a pasted string, runs them through
the injectable no-shell command runner after approval, and reads installed state
back from the host's own state files.

Three owners, with no overlap:

- The Source snapshot owns what a bundle is, meaning its manifest bytes, its
  component inventory, and its declared version.
- The host CLI owns installed state. Agent Depot reads the host's state files as
  evidence and never writes them.
- Agent Depot owns the selection record and the receipt for what it delegated.

The category follows the App discipline where it applies and departs from it where
the truth owner differs. Approval is a content-keyed receipt plus a per-run
confirmation, and the receipt is keyed on a digest of the derived declaration
(source, ref, coordinates, manifest digest, and the exact ordered argv) rather
than on a user-authored recipe file. The commands themselves are derived, so the
safety property is structural. Installed version comes from the host, so `unknown`
is a first-class status and is never rendered as `current`. A plan declares its
blast radius, because Pi's update command reconciles the whole configured
extension set.

A bundle that carries agent definitions or MCP servers reports them as
`host-only` components and lets the host own them wholly. Agent Depot never
adopts, removes, names, updates, or configures them. The bundle is managed as a
bundle.

A bundle's own skills never become a second managed copy. The canonical
`~/.agents/skills` location and the Claude symlink stay under the Skill engine,
and no `package-*` module imports that engine. A test asserts the import edge is
absent.

V1 hosts are Pi and Claude Code. V1 bundle sources are a Git repository scoped to
its root for Pi and a marketplace bound inside the same repository for Claude. A
Codex or OpenCode plugin and a Pi package with no `pi-package` shape stay
recognized but unmanaged.

## User Stories

1. As a user, I can register a bundle source and see the bundles it offers
   separately from the individual Skills inside them.
2. As a user, I can install a bundle for a chosen Host, and Agent Depot delegates
   the install to that Host's own mechanism instead of copying resources itself.
3. As a user, I can see a bundle's installed version and whether a newer version
   exists, and I am never told a bundle is installed or up to date when Agent
   Depot cannot verify it.
4. As a user, I can update and uninstall a bundle with the same preview and
   confirmation discipline the existing App and Skill flows use.
5. As a user, I can see which components a bundle provides and which of them
   Agent Depot manages rather than leaving to the Host.
6. As a user, a bundle's own Skills are not offered for adoption or installed a
   second time as unmanaged Skills.
7. As a user, I can install the same repository as a Pi package on Pi and as a
   Claude plugin on Claude, from one registered source.
8. As a user, I am asked for explicit confirmation before any host command runs,
   and a changed bundle declaration needs renewed approval.
9. As a user who already installed a bundle by hand through an App recipe, Agent
   Depot recognizes the existing host install, records the selection, and runs no
   host command.
10. As a maintainer, I can test a bundle operation through observable plans,
    results, and filesystem effects with a fake host CLI, without network access
    and without a real Pi, Claude, Codex, or OpenCode install.
11. As a user, I can export and import my bundle selections in a Profile.
12. As a user, my existing App recipes keep working, and a bundle never silently
    manages the Agent definitions or MCP servers that stay deferred.

## Implementation Decisions

The synthesized design is in `.scratch/packages/design.md`, and the arena record
that chose it is in `.scratch/packages/arena/synthesis.md`.

- **Module set.** `package-model.ts`, `package-bundles.ts`,
  `package-host-plans.ts`, `package-host-state.ts`, `package-content.ts`,
  `package-state.ts`, `package-flow.ts`, `package-cli.ts`, and
  `tui/package-actions.tsx`.
- **Identity** is `PackageCoordinates`, a union discriminated on host. A Claude
  selection carries `marketplaceRoot` and `pluginName` together. A Pi selection
  has no marketplace slot.
- **Manifests** are parsed into domain types at the boundary. No `pi` key, Claude
  component key, or host state schema reaches a caller.
- **Commands** come from frozen argv templates in `package-host-plans.ts`, one
  place per host grammar. No `HostAdapter` interface and no generic plugin
  framework, which DESIGN.md vetoes. Every produced argv is re-validated through
  the existing `parsePortableInstallationMethod` rules.
- **Approval** is a receipt at `package-approvals/<digest>.json`, mode `0600`, in
  a `0700` directory, plus a per-run confirmation, plus `recheckPlan`, which
  re-derives and diffs immediately before execution and returns `stale plan` on
  any difference.
- **Installed evidence** is read from `~/.pi/agent/settings.json` and
  `~/.claude/plugins/installed_plugins.json` through a read-only boundary. A
  missing file is an empty view. A drifted or undecodable file degrades to
  `unknown` evidence and never throws.
- **Selection records** live in one locked atomic `packages.json` beside
  `sources.json`, reusing the `SourceStateStore` lock pattern. There is no
  `package-installations/` directory.
- **Blast radius.** `plan.affects` names every recorded coordinate the action may
  change. Pi update affects every recorded Pi coordinate, because
  `pi update --extensions` reconciles host-wide.
- **Idempotence.** A plan whose action the host state already satisfies sets
  `skipExecution`, records the selection with `lastDelegatedCommit`, and runs
  nothing. This is the interop with the user's hand-made App recipes.
- **Marketplace-add idempotency.** The `add marketplace` step is omitted when the
  host already knows the marketplace. The remaining steps still run.
- **The owned-skill guard** is derived from the same snapshot pass that feeds
  skill discovery, and is called beside `assertSkillNotAppOwned`.
- **The canonical Skill constraint** is enforced by absence. `PackageEnvironment`
  exposes no skills root and no `ProjectInstallationFileSystem`, no `package-*`
  module imports the Skill install engine, and a test asserts that edge is
  missing.
- **Reused by name.** `SourceOperations` and `SourceContentAccess`,
  `canonicalizeGitSourceUrl` and `sourceIdForUrl`, `gitSourceLocation` and
  `githubTreeLocation`, `runProcess` as the only process seam,
  `writeFileAtomically`, `parsePortableInstallationMethod`, `compareAppVersions`
  and `sameAppVersion`, the extracted `resolvePortableExecutable` with its WSL
  Windows-executable block, `VersionPolicy` and `ProjectSource`, the profile
  portability rules, and the ADR 0004 refresh-before-preview and ADR 0006 shared
  core disciplines.
- **Deliberately not reused.** The App recipe parser and its `app-approvals/` and
  `app-installations/` directories, `ResolvedVersionEvidence`, and the canonical
  Skill install engine.

## Testing Decisions

- Manifest parsing and discovery run as pure functions over fixture repositories:
  a dual-format pstack-shaped repository, a Pi-only repository, a Pi repository
  with no `pi` key, and a Claude plugin with no in-repo marketplace binding.
- Host command derivation asserts exact argv vectors per host, action, and pin.
  The argv strings are the contract.
- The host state boundary is fed the observed `settings.json` shapes (a bare git
  string, an `@commit` pin, an npm string, and the object narrowing form) plus
  drifted JSON, and asserts evidence kinds without ever throwing.
- Lifecycle tests inject a fake `runner` that records argv and returns scripted
  exit codes, and a fake host-state reader backed by a mutable fixture home. They
  cover the approval gate, the recheck fail-closed path, the `skipExecution`
  interop, a verified install, a failed install, and the honest `unknown` for an
  unversioned Pi git package.
- Pi update blast radius asserts that `plan.affects` names every recorded Pi
  coordinate and that `recordOutcome` re-observes each.
- The owned-skill guard refuses a bundle-owned path with a Package pointer while a
  loose skill in the same source still installs.
- An import-graph assertion proves no `package-*` module reaches the Skill install
  engine.
- The Profile round trip exports the `packages` block declaration-only, with no
  receipt and no installed state, and imports it add-only.

## Out of Scope

- Agent definitions and MCP servers as independently managed categories. A bundle
  carrying them is managed as a bundle only.
- Codex and OpenCode plugin packaging.
- npm-sourced Pi packages. The source kind is modeled and deferred.
- Pi per-resource narrowing through the settings object form, and Pi
  project-local scope.
- Project-scoped Packages.
- Claude marketplace sources that point outside the registered repository.
- Reading host CLI prose output, including `pi list`.
- Writing any Host configuration file or any file under a Host skill root.

## Open Questions

1. **Resolved.** `claude plugin update` and `claude plugin uninstall` exist. The
   remaining part is Agent Depot's minimum supported host CLI version per host.
2. **Resolved.** `pi update <source>` updates one package. V1 uses the scoped
   verb for every action, so `plan.affects` is the selection.
3. On Windows, do the `pi` and `claude` shims run under no-shell spawn, or does
   the blocked-executable manual fallback become the norm there?
4. Does a Package carrying an executable extension warrant a gate stronger than
   preview plus confirmation, given the receipt covers derived argv rather than
   user-authored text?
