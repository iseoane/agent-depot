# Grounding: Sources, discovery, version evidence, persistence

## Components

- `src/sources.ts` holds the `Source` model (builtin versus git), the
  `SourceOperations` and `SourceDiscoveryOperations` interfaces, and
  `createSourceOperations`, which implements add, list, refresh, remove, migrate,
  select, discover, the user-global installs, and installation-method execution.
- `src/git-source.ts` holds the `GitSource` type, URL canonicalization, GitHub
  `tree/<ref>/<dir>` parsing, the bare-mirror cache, snapshot reads, ref to commit
  resolution, skill-tree limits, and the source lock.
- `src/skill-discovery.ts` holds the `SourceContentAccess` abstraction,
  `discoverSkillsFromSources`, the frontmatter parser, the builtin-root snapshot
  walk, and the content baselines.
- `src/source-state.ts` holds the per-user `sources.json` store
  (`SourceStateStore`, `defaultSourceStatePath`, `PersistedSourceState`).
- `src/project-manifest.ts` holds the project `agent-depot.json` schema,
  `ResolvedVersionEvidence`, and `AGENT_DEPOT_PACKAGE_VERSION`.
- `src/atomic-file.ts` holds `writeFileAtomically`.
- `src/profile.ts`, `src/profile-export.ts`, `src/profile-import.ts` hold the
  portable profile format, the export plan, and the import plan and apply.
- `src/cli.ts` and `src/usage-error.ts` hold the CLI grammar (`runCli`,
  `COMMANDS`, `SOURCE_SUBCOMMANDS`, `CliUsageError`).
- `src/tui/app.tsx`, `src/tui/sources-view.tsx`, `src/tui/catalog-view.tsx`,
  `src/tui/catalog-state.ts` hold the five-tab Ink shell and the catalog wiring.
- `src/app-flow.ts` holds the App operations and the env-local `apps/`,
  `app-approvals/`, and `app-installations/` layout.

## Flow

1. **Entry.** `runCli` (`cli.ts:264`) calls `createSourceOperations({
   homeDirectory })` (`sources.ts:161`), which builds the `SourceStateStore` from
   `defaultSourceStatePath`, the `GitSourceAccessAdapter`, and the
   `NodeSourceContentAccess`. It then dispatches `COMMANDS` (`cli.ts:166`) or
   `SOURCE_SUBCOMMANDS` (`cli.ts:153`).
2. **add.** `addGitSource` (`sources.ts:170`) canonicalizes the URL, derives the
   id with `sourceIdForUrl` (`git-source.ts:564`, `git:` plus the first 24 hex of
   `sha256(URL)`), and appends to `gitSources` under `stateStore.update`.
3. **refresh.** `refreshSource` (`sources.ts:198`) calls `gitAccess.refresh`, or
   `GitSourceAccessAdapter.refresh` (`git-source.ts:119`), which uses
   `gitSourceLocation(url).repositoryUrl` to run `git clone --mirror` the first
   time or `git fetch --prune --force +refs/*:refs/*` afterwards, into
   `cachePath/<id without "git:">`, guarded by a directory lock.
4. **discover.** `discoverSkills` (`sources.ts:370`) selects sources and calls
   `discoverSkillsFromSources` (`skill-discovery.ts:189`). Per source it calls
   `contentAccess.readSnapshot(source)`, keeps only `SKILL.md` basenames, drops
   paths whose directory segments are in `EXCLUDED_LIFECYCLE_SEGMENTS`
   (`in-progress`, `beta`, `deprecated`, `retired`), parses frontmatter, and emits
   `SkillCandidate { sourceId, path, name, description }`.
   - The Git snapshot path is `GitSourceSnapshotAccess.readSnapshot`
     (`git-source.ts:324`). It runs `git ls-tree -r -z <commit>` scoped to
     `githubTreeLocation(url).directory`, filters blobs named `SKILL.md`, skips
     lifecycle segments, and runs `git show <commit>:<path>` per file.
   - The builtin path is `readDirectorySnapshot`/`walkDirectory`
     (`skill-discovery.ts:424`/`441`) over `defaultBuiltInSkillsRoot()`, which is
     the package `skills/` directory. Symlinks are skipped.
5. **version.** `readResolvedVersion` (`skill-discovery.ts:143`) returns
   `{kind: "builtin-package", version: AGENT_DEPOT_PACKAGE_VERSION}` for the
   builtin, read from `../../package.json` through `createRequire`
   (`project-manifest.ts:648`), or `{kind: "git-commit", commit}` for a Git source
   from `readResolvedCommit` (`git-source.ts:307`, `git rev-parse --verify <ref ??
   githubTreeLocation(url).ref ?? "HEAD">^{commit}`).
   `readSkillTreeSnapshot` (`git-source.ts:250`, `skill-discovery.ts:126`) returns
   `{files, resolvedVersion}` as one immutable view.
6. **update decision.** `update-batch.ts:assessEvidence` (about line 238)
   consumes the evidence. `trustworthyVersion` (`update-batch.ts:405`) revalidates
   the evidence shape. A fixed policy compares its value to the pinned version. A
   latest policy uses `sameVersion`. The builtin uses `compareSemver`. The install
   path captures it in `skill-install.ts:157`.
7. **persistence.** `SourceStateStore.update` (`source-state.ts:185`) takes a
   directory lock at `<path>.lock`, loads and validates with `loadUnlocked`,
   mutates, saves with `saveUnlocked`, and publishes through `writeFileAtomically`
   (`atomic-file.ts:11`). The state shape is `{version: 1, gitSources[],
   userGlobalInstallations[]}` (`source-state.ts:12`).
8. **profile export and import.** `buildProfileExport` (`profile-export.ts:58`)
   selects sources, skills, and apps, strips machine-specific fields such as
   `installation` and `resolvedVersion`, and emits `agent-depot-profile/v1`.
   `applyProfileImport` (`profile-import.ts:188`) adds sources through
   `addGitSource`, writes recipes, and installs skills through
   `installImportedSkill` (`profile-import.ts:221`).

## Boundaries

- Inputs are the user CLI argv, the project manifest `agent-depot.json` through
  `parseProjectManifest`, profile JSON, Git remotes, the package `skills/`
  directory, and `AGENT_DEPOT_PACKAGE_VERSION`.
- Outputs are the `Source` list, `SkillCandidate[]`, `SourceSkillTreeSnapshot`,
  `PersistedSourceState` writes, profile artifacts, and TUI views.
- `SourceOperations` is the single injectable interface consumed by the CLI, the
  TUI, and profile import and export. `SourceContentAccess` is the read-only
  discovery and version seam. `SourceStateStore` is the only state writer.
  `project-manifest.ts` is shared for `ProjectSource`, `ProjectSkillSelection`,
  and `ResolvedVersionEvidence`.
- The App subsystem is parallel, not a Source. `createAppOperations`
  (`app-flow.ts:89`) derives `apps/`, `app-approvals/`, and `app-installations/`
  from the same state directory (`path.dirname(defaultSourceStatePath(...))`,
  `app-flow.ts:92-94`). Recipes are not Sources and are not discovered through
  `discoverSkills`.

## Non-obvious

- **Identity is the hash of the URL, not the URL text.** `sourceIdForUrl` is
  `git:` plus the first 24 hex of `sha256(canonical URL)`. `refresh` rejects any
  source whose `id !== sourceIdForUrl(url)`, and `parseGitSource`
  (`source-state.ts:63`) re-verifies this on every load.
- **Discovery and install read different things.** `readSnapshot` for discovery
  reads only `SKILL.md` files as text. `readSkillTreeSnapshot` for install reads
  the whole skill directory with binary blobs through `git cat-file` and enforces
  `SKILL.md` presence. Both re-apply the same lifecycle-segment exclusions, which
  are duplicated in `git-source.ts:66` and `skill-discovery.ts:20`.
- **Discovery reads nothing but the frontmatter `name` and `description`.** No
  manifest, no install method, no version. Those come from
  `readSkillTreeSnapshot` plus `readInstallationMethodFromSkillTree`
  (`sources.ts:551`), which looks for `.agent-depot.json`,
  `agent-depot-method.json`, or `installation-method.json`
  (`SOURCE_METADATA_FILENAMES`, `sources.ts:86`).
- **The GitHub directory scope is parsed from the URL and cached nowhere.**
  `githubTreeLocation` (`git-source.ts:531`) parses `tree/<ref>/<directory>`, and
  `gitSourceLocation` (`git-source.ts:556`) falls back to the plain URL for
  non-GitHub hosts. The registered URL keeps the `tree/...` form and only
  transport and discovery use the derived `repositoryUrl` and `directory`. A plain
  URL carries its ref in `GitSource.ref`, while the GitHub form encodes the ref in
  the URL path.
- **`resolveProjectSource` cannot handle a path-based project source.** It throws
  `SourceMetadataError` with "Git-only V1 adapter" (`sources.ts:469`). Path sources
  exist in the manifest type (`ExternalPathProjectSource`,
  `project-manifest.ts:30`) but are not resolvable through the V1 adapter.
- **Mirrors are bare and never checked out.** `git clone --mirror` then reads with
  `--git-dir <mirror>` plus `ls-tree`, `cat-file`, and `show`. No working tree
  exists.
- **`writeFileAtomically` has a Windows-only in-place rewrite fallback**
  (`allowLockedReplaceFallback`), used only by `SourceStateStore` while it holds
  its directory lock. Other callers fail closed on a rename conflict.
- **Atomic write and recipe publish differ.** State uses `writeFileAtomically`.
  Profile and recipe writes use `writeFile` with `flag: "wx"` plus `link`
  (`profile-import.ts:171`), so an existing file is never silently replaced.
- **A user-global install is just a manifest selection persisted in
  `sources.json`.** `UserGlobalSkillInstallation` is `ProjectSkillSelection`
  (`source-state.ts:10`), keyed by `JSON.stringify([source, path])`.
- **`SkillCandidate` carries `sourceId`, not the `Source` object.** The TUI's
  `useCatalogSkills` (`catalog-state.ts:24`) calls `discoverSkills` in batch first,
  then falls back per source to isolate one failing source and emit a "refresh
  with r" warning.

## Open questions

- The skill tree limits are enforced in two places, the Git path and the builtin
  walker. Whether they share identical limit semantics was not verified. They
  reference the same constants but enforce through different callbacks.
- Whether a user-supplied ref overrides or conflicts with a GitHub-embedded ref in
  the install and update paths was not traced.
- `resolveSourceVersion` at `sources.ts:357` duplicates
  `NodeSourceContentAccess.readResolvedVersion`. Which one wins for each embedder
  was not traced.
