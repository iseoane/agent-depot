# Package category: synthesized design

Base is arena candidate-2, with the candidate-3 and candidate-1 grafts folded in.
The arena record is `.scratch/packages/arena/synthesis.md`. Bodies are
`not implemented`; tricky logic is `// TODO` pseudocode.

## 1. What a Package is

A **Package** is a host-native bundle inside a registered Source. Agent Depot
reads the bundle's own manifest into a typed component inventory, generates the
host CLI commands from the typed declaration rather than from a pasted string,
runs them through the injectable no-shell runner after approval, and reads
installed state back from the host's own state files. It never materializes bundle
content and never writes under a Host skill root.

The consumer's view:

```text
agent-depot package list
agent-depot package discover <source-id>
agent-depot package inspect <source-id>::<bundle-path> --host pi|claude
agent-depot package approve <selection> --host pi|claude
agent-depot package install|update|uninstall <selection> --host pi|claude [--yes]
agent-depot package forget <selection> --host pi|claude --yes
```

No caller writes a command string. No caller parses a `pi` key or a
`.claude-plugin` path.

## 2. Ownership and load-bearing decisions

Three owners, and no overlap.

- The **Source snapshot** owns what a bundle is: its manifest bytes, its
  component inventory, and its declared version.
- The **host CLI** owns installed state. Agent Depot reads the host's state files
  as evidence and never writes them.
- **Agent Depot** owns the selection record and the receipt for what it
  delegated.

The load-bearing decisions:

1. **Identity is host-discriminated.** `PackageCoordinates` is a union, so a
   Claude selection carries `marketplaceRoot` and `pluginName` together and a Pi
   selection has no marketplace slot. Per-host identity is accepted in exchange
   for never synthesizing a key that contradicts a host's own dedup rule.
2. **Commands are derived, never pasted.** `planHostSteps` is a pure function from
   a validated descriptor and selection to argv. Nothing user-authored reaches the
   runner, so the safety property is structural rather than validated.
3. **Two gates, plus a recheck.** A content-keyed receipt keyed on the derived
   declaration digest, then a per-run confirmation, then `recheckPlan`, which
   re-derives and diffs immediately before execution and fails closed on any
   difference.
4. **Host state is read, not recorded.** There is no
   `packages-installations/<key>.json` version record. Installed evidence comes
   from `~/.pi/agent/settings.json` and
   `~/.claude/plugins/installed_plugins.json`, so `unknown` is a first-class
   status rather than a guess.
5. **A plan declares its blast radius.** `plan.affects` names every recorded
   coordinate the host command may change. V1 uses the scoped verb for every
   action, so in V1 that is the selection's own coordinates. The mechanism stays
   because a host-wide verb is one line away, and
   `claude plugin marketplace update` without a name is a live trap.
6. **The canonical Skill location stays untouched.** The constraint is enforced by
   absence, and a test asserts the import edge does not exist.

## 3. Types

```ts
// src/package-model.ts
import type { ProjectHost, ProjectSource, VersionPolicy } from "./project-manifest.js";

/** V1 bundle hosts. Codex and OpenCode packaging stays recognized but deferred. */
export const PACKAGE_HOSTS = Object.freeze(["pi", "claude"] as const satisfies readonly ProjectHost[]);
export type PackageHost = (typeof PACKAGE_HOSTS)[number];

/** Where a bundle is. Stable while its manifest changes, so a rename is drift, not identity. */
export type PackageCoordinates =
  | { readonly host: "pi"; readonly root: string }
  | { readonly host: "claude"; readonly marketplaceRoot: string; readonly pluginName: string };

export type PackageSelection = PackageCoordinates & {
  readonly source: ProjectSource;
  readonly version: VersionPolicy;
};

/** Modeled for a later wave. V1 ships only the `git` and `marketplace` kinds. */
export type PackageSourceKind =
  | { readonly kind: "git"; readonly url: string; readonly ref?: string }
  | { readonly kind: "marketplace"; readonly url: string; readonly plugin: string }
  | { readonly kind: "npm"; readonly package: string; readonly version?: string };

export type PackageComponentKind =
  | "skills" | "extensions" | "prompts" | "themes"
  | "agents" | "commands" | "hooks" | "mcp-servers" | "lsp-servers"
  | "output-styles" | "workflows" | "monitors";

/** Who owns a component once the host CLI has it. */
export type PackageComponentOwnership = "skill-category" | "host-only";

/** What the host does with it. Drives the risk line in the preview. */
export type PackageComponentEffect = "executable" | "instruction" | "data";

export interface PackageComponent {
  readonly kind: PackageComponentKind;
  readonly ownership: PackageComponentOwnership;
  readonly effect: PackageComponentEffect;
  readonly paths: readonly string[];
  readonly skillNames?: readonly string[];
}

/** The single list of categories Agent Depot reports but never manages. */
export const DEFERRED_COMPONENT_KINDS = Object.freeze(["agents", "mcp-servers"] as const);

export interface BundleDescriptor {
  readonly host: PackageHost;
  readonly coordinates: PackageCoordinates;
  readonly name: string;
  readonly version?: PackageVersionEvidence;
  readonly components: readonly PackageComponent[];
  readonly warnings: readonly string[];
  /** Keys the approval receipt. sha256 over the bundle's raw manifest bytes, sorted by path. */
  readonly manifestDigest: string;
}

/** A version Agent Depot can state about the available bundle. */
export type PackageVersionEvidence =
  | { readonly kind: "manifest-version"; readonly version: string; readonly declaredBy: "bundle" | "marketplace-entry" }
  | { readonly kind: "git-commit"; readonly commit: string };

/** What the host reports about an install. Read-only evidence, never written. */
export type InstalledBundleEvidence =
  | { readonly kind: "installed"; readonly version?: string; readonly commit?: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/** What Agent Depot owns. The presence of the record is the selection, not the install. */
export interface InstalledPackage {
  readonly selection: PackageSelection;
  readonly installId: string;
  readonly lastDelegatedCommit?: string;
  readonly verified?: PackageVersionEvidence;
  readonly verifiedAt: string;
}

export interface PersistedPackageState {
  readonly version: 1;
  readonly packages: readonly InstalledPackage[];
}

export interface PackageInspection {
  readonly descriptor?: BundleDescriptor;
  readonly installed: InstalledBundleEvidence;
  readonly available?: PackageVersionEvidence;
  readonly approval: "approved" | "needs approval";
  readonly drift?: string;
}

export interface PackageCommand {
  readonly purpose: "register" | "apply" | "remove";
  readonly executable: string;
  readonly resolvedPath?: string;
  readonly args: readonly string[];
  readonly summary: string;
}

export interface PackagePlanOrigin {
  readonly manifestDigest: string;
  readonly installId: string;
  readonly resolvedCommit?: string;
}

export interface PackageLifecyclePlan {
  readonly selection: PackageSelection;
  readonly action: PackageAction;
  readonly descriptor: BundleDescriptor;
  readonly commands: readonly PackageCommand[];
  /** Every recorded coordinate this action may change. V1 actions are all scoped. */
  readonly affects: readonly PackageCoordinates[];
  readonly warnings: readonly string[];
  readonly cwd: string;
  readonly environment: string;
  readonly origin: PackagePlanOrigin;
  /** Host state already satisfies the action. The plan runs nothing. */
  readonly skipExecution?: boolean;
}

export type PackageAction = "install" | "update" | "uninstall" | "select" | "forget";

export type PackageLifecycleResult =
  | { readonly status: "installed"; readonly verified: InstalledBundleEvidence }
  | { readonly status: "updated"; readonly previous: InstalledBundleEvidence; readonly verified: InstalledBundleEvidence }
  | { readonly status: "removed" }
  | { readonly status: "selected" }
  | { readonly status: "forgotten" }
  | { readonly status: "not confirmed" }
  | { readonly status: "stale plan"; readonly reason: string }
  | { readonly status: "manual required"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly output?: string };

export interface PackageUpdateCheck {
  readonly installed: InstalledPackage;
  readonly status: "unknown" | "current" | "update available";
  readonly available?: PackageVersionEvidence;
  readonly reason?: string;
}

/** What the receipt covers. Digest = sha256 of a canonical JSON serialization. */
export interface PackageDeclaration {
  readonly sourceUrl: string;
  readonly ref?: string;
  readonly coordinates: PackageCoordinates;
  readonly manifestDigest: string;
  readonly argv: readonly (readonly string[])[];
}

/** A host install token that has already passed a host-identity validator. */
export type HostInstallSpec = string & { readonly __hostInstallSpec: unique symbol };
```

Invariants encoded in types: a Claude selection cannot omit its marketplace; a
`git-commit` and a `manifest-version` never compare, so the check reports
`unknown`; the deferred kinds live in one exported list; the removal cartesian
product of hosts and component kinds is not a type.

## 4. Signatures

### 4.1 Boundary: manifests and host state

```ts
// src/package-bundles.ts — pure
export function parsePiPackageManifest(raw: string, root: string): BundleDescriptor;
export function parseClaudePluginManifest(raw: string, root: string): BundleDescriptor;
export function parseClaudeMarketplace(raw: string, root: string): readonly BundleDescriptor[];
export function buildComponentInventory(host: PackageHost, manifest: unknown): readonly PackageComponent[];
export function discoverBundlesInSnapshot(
  files: readonly SourceContentFile[],
  scope: { readonly directory?: string },
): readonly BundleDescriptor[];
// not implemented. One pass indexes package.json at the scope root and
// .claude-plugin/*.json anywhere under it. A dual-format repository yields two
// descriptors over the same skills directory. The inventory reads pi globs and
// conventional directories, or the Claude component keys, and applies the same
// EXCLUDED_LIFECYCLE_SEGMENTS skill filter skill discovery uses.
// TODO: refuse a Pi manifest below the scope root, refuse a scoped GitHub Source
// URL for Pi, and mark a Claude plugin with no in-repo marketplace binding as
// not installable rather than guessing a source.

// src/package-host-state.ts — boundary, read-only
export function parsePiPackagesSetting(value: unknown): readonly PiInstallRecord[];
export function parseClaudePluginState(value: unknown): readonly ClaudeInstallRecord[];
export function parseClaudeMarketplaceState(value: unknown): readonly ClaudeMarketplaceRecord[];
export async function readHostInstallView(env: {
  readonly homeDirectory?: string;
  readonly readHostStateFile?: (path: string) => Promise<string>;
}): Promise<HostInstallView>;
export function findInstalledBundle(
  view: HostInstallView, descriptor: BundleDescriptor, selection: PackageSelection,
): InstalledBundleEvidence;
// not implemented. Missing files are an empty view. A drifted or undecodable file
// degrades to `unknown` evidence for the lookups it affects and never throws.
// Pi identity is the repository URL without the ref. npm-shaped records never match.
```

### 4.2 Host grammar and evidence

```ts
// src/package-host-plans.ts — pure
export const HOST_STEP_TEMPLATES: Readonly<Record<
  PackageHost,
  Readonly<Record<PackageAction, (input: StepTemplateInput) => readonly (readonly string[])[]>>
>>;
// pi.install:   [["pi", "install", piSpec]]
// pi.update:    [["pi", "update", piSource]]            scoped, verified
// pi.uninstall: [["pi", "remove", piSource]]
// claude.install:   [["claude","plugin","marketplace","add", url],   omitted when known
//                    ["claude","plugin","install", "<plugin>@<marketplace>"]]
// claude.update:    [["claude","plugin","marketplace","update", marketplace],   always named
//                    ["claude","plugin","update", installId]]
// claude.uninstall: [["claude","plugin","uninstall", installId]]
// select and forget run nothing.
// Every argv is re-validated through parsePortableInstallationMethod at plan time.
// Verbs verified on this machine; see `.scratch/packages/arena/host-cli-verbs.md`.
// A bundle-declared `command` marketplace source is refused, because the host
// gates it behind `--accept-command <sha256>`, which Agent Depot cannot present.

export function planHostSteps(
  action: PackageAction, descriptor: BundleDescriptor, selection: PackageSelection,
  state: HostInstallView,
): readonly (readonly string[])[];
// Throws when a Claude descriptor has no marketplace binding. That is the
// type-level manual branch made explicit at the boundary.

export function affectedBy(
  action: PackageAction, selection: PackageSelection, recorded: readonly PackageSelection[],
): readonly PackageCoordinates[];
// install, uninstall, select, forget affect [selection.coordinates].
// update affects [selection.coordinates] with the V1 scoped verbs. Return every
// recorded Pi coordinate only if a host-wide verb is ever chosen.

export function packageApprovalDigest(declaration: PackageDeclaration): string;
export function classifyUpdate(
  installed: InstalledBundleEvidence, available: PackageVersionEvidence | undefined,
): "unknown" | "current" | "update available";
// TODO: both manifest versions compare through sameAppVersion/compareAppVersions.
// Both commits compare by equality. Mixed kinds, or missing evidence, is unknown.
```

### 4.3 Source snapshot port

```ts
// src/package-content.ts
export interface PackageSourceView {
  readonly sourceId: string;
  /** Where a host must be pointed. Never a local mirror path: mirrors are bare. */
  readonly origin: HostFacingOrigin;
  readonly resolvedCommit?: string;
  find(root: string, names: readonly string[]): Promise<readonly string[]>;
  list(root: string): Promise<readonly string[]>;
  read(path: string): Promise<string | undefined>;
}

export type HostFacingOrigin =
  | { readonly kind: "git"; readonly repositoryUrl: string; readonly ref?: string; readonly directory?: string }
  | { readonly kind: "builtin" };

export interface PackageContentAccess {
  readView(source: Source): Promise<PackageSourceView>;
}
export function createNodePackageContentAccess(options?: {
  readonly builtInRoot?: string;
  readonly gitCachePath?: string;
}): PackageContentAccess;
// No field carries a filesystem path a host CLI could be given.
// GitSourceSnapshotAccess gains listFiles and readFile so this port does not
// duplicate requireMirror, readResolvedCommit, or the symlink guard.
```

### 4.4 The deep module

```ts
// src/package-flow.ts
export interface PackageEnvironment {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoot?: string;
  readonly stateDirectory?: string;
  readonly runner?: typeof runProcess;
  readonly resolveExecutable?: (name: string) => Promise<string | undefined>;
  readonly sourceOperations?: SourceOperations;
  readonly contentAccess?: PackageContentAccess;
  readonly readHostStateFile?: (path: string) => Promise<string>;
  readonly adapters?: readonly PackageHostAdapter[];
}

export interface PackageOperations {
  /** Bundles in the selected Sources. Runs no external command. */
  discover(sourceIds: readonly string[]): Promise<readonly BundleDescriptor[]>;
  /** Recorded selections, resolved against sources and snapshots. */
  list(): Promise<readonly InstalledPackage[]>;
  /** One selection against the live Source. Runs no external command. */
  inspect(selection: PackageSelection): Promise<PackageInspection>;
  approvalStatus(selection: PackageSelection): Promise<"approved" | "needs approval">;
  /** Re-derives the declaration from the current snapshot and writes the receipt. */
  approve(selection: PackageSelection): Promise<void>;
  /** Refreshes the Source first, per ADR 0004, then freezes the plan. */
  planLifecycle(selection: PackageSelection, action: PackageAction): Promise<PackageLifecyclePlan>;
  /** Re-derives, diffs, requires confirmation, runs, re-observes, records. */
  executeLifecycle(plan: PackageLifecyclePlan, confirmed: boolean): Promise<PackageLifecycleResult>;
  /** Drops the selection record. Runs no host command. */
  forget(selection: PackageSelection, confirmed: boolean): Promise<void>;
  /** Batched assessment with per-Package failure isolation. */
  checkUpdates(selections?: readonly PackageSelection[]): Promise<readonly PackageUpdateCheck[]>;
}

export function createPackageOperations(environment: PackageEnvironment = {}): PackageOperations;
```

`executeLifecycle` in order: require `confirmed`; `recheckPlan`, which re-derives
and diffs `manifestDigest`, `installId`, `resolvedCommit`, and the ordered
commands, returning `stale plan` on any difference; honour `skipExecution` by
recording the selection with `lastDelegatedCommit` and running nothing; resolve
each executable and fall back to `manual required` on a blocked WSL Windows
executable; run each command through `runner(executable, args, { cwd })` with no
shell and capped output, stopping on the first non-zero exit; `recordOutcome`,
which re-observes every coordinate in `plan.affects` and writes only the records
whose bundle still resolves. Update additionally requires the observed version to
differ from the previous one.

### 4.5 The owned-skill guard

```ts
// src/package-owned-skills.ts
export function bundleOwnedSkillMatcher(
  descriptors: readonly BundleDescriptor[],
): (skillPath: string) => BundleDescriptor | undefined;
export function assertSkillNotPackageOwned(
  skillPath: string, owned: (skillPath: string) => BundleDescriptor | undefined,
): void;
// Built from the same readSnapshot pass that fed skill discovery, so there is no
// second walk and no hand-synced list. Called beside assertSkillNotAppOwned in
// skill-install.ts and user-global-skill-inventory.ts.
```

## 5. Module map

```text
src/package-model.ts         domain types and pure helpers. Imports project-manifest.ts only.
src/package-bundles.ts       manifest parsing, discovery, inventory, owned-skill matcher.
src/package-host-plans.ts    frozen argv templates, affectedBy, approval digest, classifyUpdate.
src/package-host-state.ts    host state files to InstalledBundleEvidence, read-only.
src/package-content.ts       PackageSourceView / PackageContentAccess port and Node implementation.
src/package-state.ts         packages.json store. The one writer for selections and receipts.
src/package-flow.ts          createPackageOperations: discover, inspect, plan, execute, updates.
src/package-cli.ts           runPackageCommand. Thin grammar and preview, per ADR 0006.
src/tui/package-actions.tsx  preview, approve and confirm modes. Mirrors app-actions.tsx.

Touched: src/git-source.ts (+listFiles/readFile), src/executable-resolution.ts (extracted
from createAppOperations), src/cli.ts (+package), src/skill-install.ts and
src/user-global-skill-inventory.ts (guard), profile modules (+packages), src/update-batch.ts
(+Package checks), src/tui/installations-view.tsx and src/tui/catalog-view.tsx (+Package rows).
```

State layout, Linux `~/.local/state/agent-depot/` and Windows
`%APPDATA%/Agent Depot/`:

```text
packages.json                 selections, one locked atomic store, reusing the SourceStateStore pattern
package-approvals/<digest>.json   receipts, mode 0600, directory 0700
```

There is no `package-installations/` directory. The host owns installed state.

Dependency direction is one way and at most three hops:
`package-cli` to `package-flow` to (`package-bundles` | `package-host-plans` |
`package-host-state` | `package-content` | `package-state`). No `package-*`
module imports the Skill install engine, and a test asserts that edge is absent.

## 6. Verifiable units

| Unit | Proof |
|---|---|
| Manifest parse, Pi | `package-bundles.test.ts` over a fixture with `package.json` and a `pi` key. Assert components, paths, inventory, manifest digest. |
| Manifest parse, Pi conventional | Fixture with `skills/` and `extensions/` and no `pi` key. Same assertion. |
| Manifest parse, Claude | pstack-shaped fixture. Assert the plugin descriptor, the marketplace binding, the component list, and the deferred kinds. |
| One repository, both formats | The pstack-shaped fixture yields one Pi descriptor and one Claude descriptor over the shared `plugins/pstack/skills`. |
| Host argv | Exact `runner` call assertions for every host, action and pin. The argv strings are the contract. |
| Claude sequencing | Two recorded calls, `register` before `apply`. |
| Marketplace-add idempotency | A known marketplace omits only the `add` step and still runs `install`. |
| Host state boundary | `package-host-state.test.ts` over the observed `settings.json` shapes and `installed_plugins.json`, plus drifted JSON. Assert evidence kinds, never a throw. |
| Lifecycle | `package-flow.test.ts` with a fake runner and a fake host-state reader. Approval gate, recheck fail-closed, `skipExecution` interop, verified install, failed install, honest `unknown`. |
| Pi update blast radius | Two recorded Pi packages. Assert `plan.affects` names both, and `recordOutcome` re-observes both. |
| Owned-skill guard | A bundle-owned skill path is refused with a Package pointer; a loose skill in the same source still installs. |
| No second managed copy | An import-graph assertion that no `package-*` module reaches `project-installation.ts` or the Skill install engine. |
| Profile round trip | Export emits the `packages` block declaration-only, with no receipt and no installed state, and import replays it add-only. |

## 7. Docs and deferred scope

- **SPEC.md** removes plugins and extensions from the deferred list, adds Package
  as a confirmed category, and narrows the deferred list to agent definitions and
  MCP servers.
- **CONTEXT.md** gains Package, bundle, component inventory, and marketplace
  binding, and drops the avoid-note that told readers not to use the word Package.
- **DESIGN.md** removes plugins and extensions from the deliberate exclusions and
  adds a Package section beside the App recipe section. The "no generic plugin
  framework" line stays true, because Packages are explicit logic and frozen
  tables, not a framework.
- **A new ADR 0009** records the ownership boundary: hosts own installed state,
  Agent Depot derives argv from manifests and records delegated intent, approval
  is keyed on the derived declaration digest, and no Agent Depot write lands under
  a Host skill root.
- **docs/research/host-resource-compatibility.md** amends its recommended V1
  interpretation, which currently says portable skills are the only confirmed
  category.

Still deferred: agent definitions and MCP servers as independently managed
categories. A bundle that carries them reports them as `host-only` components
with their effect, shows them in every preview, and lets the host own them wholly.
Also deferred: Codex and OpenCode packaging, npm-sourced Pi packages, Pi
per-resource narrowing, project-scoped Packages, external Claude marketplace
sources, and reading host CLI prose.

## 8. Open questions to resolve before implementation

1. **Resolved.** `claude plugin update <plugin>` and
   `claude plugin uninstall <plugin>` exist, verified on this machine. The
   remaining question is Agent Depot's minimum supported host CLI version for
   each host, which no primary source states yet.
2. **Resolved.** `pi update <source>` updates one package and
   `pi update --extensions` updates all of them. V1 uses the scoped form, so
   `plan.affects` is the selection. Verified in
   `.scratch/packages/arena/host-cli-verbs.md`.
3. On Windows, does the `claude` and `pi` shim run under no-shell spawn, or does
   the blocked-executable manual fallback become the norm there?
4. Does a Package carrying an executable extension warrant a stronger gate than
   preview plus `--yes`, given that the receipt covers derived argv rather than
   user-authored text?

## 9. Implementation reconciliation

First wave, issues 01 to 03, accepted deviations and rejections.

**Accepted.** `parseClaudeMarketplace` takes a third parameter,
`readPluginManifest: (pluginRoot: string) => string | undefined`. The two-argument
signature cannot apply the marketplace-entry version override or report a plugin's
agents, because both live in the plugin's own `plugin.json` and the function is
pure. The resolver keeps the purity and fixes the signature.

**Accepted.** Component `paths` are source-root-relative, resolved against the
bundle root at parse time. The design did not pin the path base. This reading is
the one that makes the dual-format claim literal, because the Pi and the Claude
descriptor then both name `plugins/pstack/skills`.

**Pinned after review.** `PackageComponent.effect` per kind, which the design left
unspecified. `extensions`, `hooks`, `monitors`, `mcp-servers`, and `lsp-servers`
are `executable`. `skills`, `agents`, `commands`, and `workflows` are
`instruction`. `prompts`, `themes`, and `output-styles` are `data`. The first wave
had `mcp-servers` and `lsp-servers` as `data`, which understates risk, because both
cause the host to launch a process, and `effect` drives the risk line in the
preview. Corrected in the same commit as this note.

**Rejected.** Nothing was rejected in the first wave. No deviation was left
unrecorded.

**Verified.** `pnpm typecheck`, `pnpm lint`, `pnpm audit:dead-code`, and
`git diff --check` are clean, and `pnpm test` passes 768 tests, which includes the
15 in `tests/package-bundles.test.ts`. The load-bearing assertion that a
dual-format repository yields one Pi descriptor and one Claude descriptor over the
shared skills directory is present and passes.

Issue 09, the owned-skill guard, accepted and pinned the following.

**Accepted.** The guard matches a bare Skill directory name as well as a Skill
path. Design 4.5 pinned one matcher, and the unmanaged inventory knows only a
local directory name, so a path-only matcher would leave the guard inert at its
remove and inventory call sites. `bundleOwnedSkillNameMatcher` reads the
`skillNames` the snapshot pass already collects, and `packageOwnedSkillMatcher`
applies it only to an input with no path separator, so an install still checks the
exact Source-relative path.

**Accepted.** `SourceContentAccess.readSnapshot` now carries the bundle manifests
beside the Skill files, through `isSourceSnapshotFile`: the scope-root
`package.json` and the two `.claude-plugin` manifests. Before this, both
implementations returned `SKILL.md` files only, so `discoverBundlesInSnapshot`
returned no descriptor for any real Source and the guard could not refuse
anything. Design 4.5 names `readSnapshot` as the pass the matcher is built from,
so the snapshot is where the missing bytes belonged. Skill discovery filters for
`SKILL.md` itself, so it is unchanged apart from reading a few extra blobs.

**Pinned after review.** Every discovered descriptor owns its Skills, including a
Claude plugin with no in-repo marketplace binding. The bundle owns those Skill
paths whether or not its own lifecycle is installable, and the matcher has no
installability concept to filter on.

**Verified.** `pnpm typecheck`, `pnpm lint`, and `git diff --check` are clean, and
`pnpm test` passes 787 tests, which includes the 11 in
`tests/package-owned-skills.test.ts`. `pnpm audit:dead-code` reports one boundary
coverage issue, `src/package-owned-skills.ts:1 no matching boundary zone`; the
zone line is deliberately left to a separate commit.

Issue 08, the flow, plus the integration of issues 04, 05 and 07, accepted and
pinned the following.

**Accepted.** The flow reads a Source through `SourceContentAccess.readSnapshot`,
not through `PackageSourceView`. Discovery consumes path-and-content snapshots,
and issue 09 already made that pass carry the bundle manifests, so the flow, the
guard, and Skill discovery share one read instead of the flow maintaining a
second bridge that reads every file to fill in contents. `PackageContentAccess`
stays the host-facing origin port, with its own tests, for the CLI wave that
needs to hand a host a repository URL.

**Accepted.** `approve` and `approvalStatus` take an optional action, defaulting
to `install`. `PackageDeclaration.argv` is one action's exact ordered argv, and
the install, update and uninstall argvs differ, so a single action-less receipt
could never approve an update. The digest still binds source, ref, coordinates,
manifest digest and the ordered argv.

**Accepted.** `planHostSteps` refuses a fixed-version Claude selection for
install and update. `claude plugin install <plugin>@<marketplace>` has no pin
slot, so the alternative is to install whatever the marketplace points at while
the record claims the pin. See issue 15.

**Accepted.** `hostInstallId` joins `planHostSteps` in the host-grammar module,
and both derive from one `stepTemplateInput`, so the record's `installId` is the
same token the argv carries rather than a second spelling of it.

**Accepted.** `sourceBundleScope` gives the flow and the owned-Skill guard the
same directory scope for a scoped GitHub tree Source. Without it a Pi bundle
below the scope root was invisible to both.

**Accepted.** `recordOutcome` drops the selection record after a confirmed
uninstall and on `forget`, and writes it for install, select, and update. The
record is the selection, not the install, so a confirmed removal has nothing
left to select.

**Verified.** `pnpm typecheck`, `pnpm lint`, `pnpm audit:dead-code` and
`git diff --check` are clean, and `pnpm test` passes 858 tests, which includes
the 16 in `tests/package-flow.test.ts` covering the completed install, the
frozen plan, the manifest and commit recheck, the unapproved fail-closed path,
the hand-installed interop, the failed install, the honest `unknown`, the
unchanged-version update, the batch isolation, the Claude argv order, the blocked
WSL executable, and the absent Skill-engine import edge.
