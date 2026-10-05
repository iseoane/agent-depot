# Grounding: the Skill lifecycle and Host exposure

## Components

- `src/project-installation.ts` is the core engine. It inspects, installs,
  adopts, overwrites, updates, and removes one Skill, and owns path safety, the
  canonical layout, rollback, and symlink creation.
- `src/skill-install.ts` holds the shared plan, preview, and execute flow for one
  selection in either scope, plus source resolution, the external method, and
  collision rejection.
- `src/project-manifest.ts` holds the `agent-depot.json` schema (v1),
  `ProjectSkillSelection`, `ProjectSkillInstallation`, `VersionPolicy`,
  `ResolvedVersionEvidence`, the parser and writer, and `ProjectManifestStore`.
- `src/skill-hosts.ts` plans and executes adding or removing Hosts on an installed
  user-global Skill. The only filesystem change is the Claude symlink.
- `src/skill-adoption.ts` holds `compareSkillTrees` and `readExistingSkillTree`,
  which define byte-exact identity with executable mode ignored.
- `src/skill-removal.ts` holds managed user-global removal: selection, inspect,
  preview, recheck, delete files, reconcile records.
- `src/unmanaged-removal.ts` holds the recheck-and-delete path for unmanaged
  directories and symlinks.
- `src/user-global-skill-inventory.ts` scans `~/.agents/skills` and
  `~/.claude/skills` and classifies managed, unmanaged, skipped, exposure, and
  symlink entries.
- `src/skill-update.ts` holds the per-Skill update preview and apply with a
  transactional filesystem replacement.
- `src/update-batch.ts` assesses every installed selection against a current
  Source snapshot into `updateable`, `current`, or `unknown`.
- `src/update-flow.ts` wires the scope: `loadUpdates`,
  `previewUpdateCandidates`, `describeUpdatePreview`,
  `findPathConfirmationProblem`, `applyConfirmedUpdates`.
- `src/source-state.ts` persists the user-global `sources.json` with `gitSources`
  and `userGlobalInstallations`, locked and atomic.
- `src/path-safety.ts` holds `pathsOverlap` and `assertNoSymlinkPath`.

## Flow

**Install, in both scopes.**
1. `cli.ts` `runSingleProjectInstall` (about 1280) or `runUserGlobalInstall`
   (about 1298) calls `planSingleInstall` (`skill-install.ts:498`).
2. `selectInstallSource` (68) resolves the Source, builds a `ProjectSource`,
   requires `--portable-v1`, and rejects a fixed builtin version that differs from
   the package version. `parseProjectManifest` normalizes the selection.
3. `resolveInstallInspection` (93) resolves the project source, refreshes a Git
   source only when confirmed, resolves the selection (131, which reads the
   preview tree snapshot and validates it), and calls
   `inspectProjectSkillInstallation` (`project-installation.ts:625`).
4. `outputSingleInstallPreview` (514) prints the target, collision, locations, and
   method. The gate is `requireConfirmation(--yes)` (`cli.ts:1515`).
5. `executeSingleInstall` (523) asserts the Skill is not App-owned, asserts no
   managed installation overlap, rejects a collision unless it is
   `missing-file`, `extra-file`, or `content-mismatch`, runs `installOne`, then
   persists, then runs the external method.
6. `installProjectSkillTransaction` (`project-installation.ts:772`) adopts an
   existing project Skill when it matches, otherwise creates the real tree at
   `.agents/skills/<name>` with `wx` writes and modes 755 and 644, and creates a
   relative symlink at `.claude/skills/<name>`. It returns a rollback receipt.
7. Persist. Project goes to `ProjectManifestStore.save` (`cli.ts:1289`).
   User-global goes to `addUserGlobalInstallation` (`cli.ts:1316`). A persistence
   failure triggers `rollbackTransactions`.

**Host add and remove, user-global only.**
- `runSkillHostAdd` (`cli.ts:632`) plans with `planHostAddition`
  (`skill-hosts.ts:70`, `inspectProjectSkillHostAddition` at
  `project-installation.ts:382`), then takes two gates, `requireConfirmation(--yes)`
  and `requireConfirmation(--confirm-additional-host)`. `executeHostAddition` (94)
  rechecks the flag, asserts the managed records are unchanged, calls
  `addProjectSkillHosts` (`project-installation.ts:408`, which only ever creates
  the Claude symlink), updates the user-global installation, and rolls back on
  failure.
- `runSkillHostRemoval` (`cli.ts:594`) plans with `planHostRemoval`
  (`skill-hosts.ts:124`). All Hosts become a full `planSkillRemoval`. Otherwise
  `deletePaths` holds the Claude path only when Claude is removed, guarded against
  Claude being the sole copy. `executeHostRemoval` (157) rechecks, calls
  `removeProjectSkill` with `deletePaths`, then updates the record with the
  remaining Hosts.

**Update.**
- `runUpdate` (`cli.ts:895`) loads through `loadUpdates` (`update-flow.ts:68`) and
  assesses with `assessUpdateBatch` (`update-batch.ts:79`). Per selection it
  resolves the Source and reads the current snapshot. `trustworthyVersion` accepts
  a builtin-package version or a 40 or 64 hex git commit. `assessEvidence` (207)
  decides `updateable` on a version mismatch or a baseline digest mismatch, and
  `unknown` on missing or untrusted evidence or a builtin pin mismatch.
- `previewSkillUpdate` (`skill-update.ts:76`) inspects and reports
  `requiresOverwriteConfirmation` and `nonCanonicalPath`.
- `findPathConfirmationProblem` (`update-flow.ts:179`) requires an exact
  `--confirm-path` for every non-canonical path. An unmatched `--confirm-path` is
  an error.
- `applyConfirmedUpdates` (`update-flow.ts:192`) reaches `applySkillUpdate`
  (`skill-update.ts:110`), which prepares the persisted selection, runs
  `updateProjectSkillTransaction` (`project-installation.ts:462`), executes the
  external method, persists, and commits.

**Removal.**
- Managed. `planSkillRemoval` inspects through `inspectSkillRemovals`
  (`skill-removal.ts:78`) and `inspectProjectSkillRemoval`
  (`project-installation.ts:210`), which reads the baseline digest and appends the
  Claude symlink to `paths`. `executeSkillRemoval` (183) reaches
  `removeSkillsAndRecords` (139), which per item rechecks the inspection and
  records, removes the project Skill, and removes the user-global installations.
- Unmanaged. `scanUserGlobalSkillInventory`
  (`user-global-skill-inventory.ts:114`) feeds `inspectUserGlobalSkillRemoval`
  (470) and `removeUserGlobalSkill` (481). Removal renames to
  `.<name>.agent-depot-unmanaged-stage-<uuid>`, revalidates the staged tree, then
  removes it with force false and restores on drift. A symlink is unlinked only.

## Boundaries

- Inputs are CLI argv and TUI key events into `SourceOperations` (list and
  discover Sources, `readSkillTree[Snapshot]`, the user-global installation
  methods, and the installation-method readers and executors), plus
  `ProjectSkillTreeAccess` and the injectable `ProjectInstallationFileSystem`.
- Outputs and state are the project `agent-depot.json` through
  `ProjectManifestStore` with atomic temp and rename, the user-global
  `sources.json` at `$XDG_STATE_HOME/agent-depot/sources.json` on Linux and
  `%APPDATA%/Agent Depot/sources.json` on Windows with a `.lock` file, the trees
  at `.agents/skills/<name>` and the `.claude/skills/<name>` symlink, and retained
  backups and stage directories.
- An external method is a no-shell `SourceInstallationMethod`. It runs after
  persistence. A failure leaves the installed files, because the method side
  effects cannot be rolled back.

## Non-obvious

- **Claude is always a symlink.** Pi, Codex, and OpenCode share `.agents/skills`.
  Adding or removing a non-Claude Host changes only the record, so `createPaths`
  and `deletePaths` are empty. Only the Claude link is ever created or deleted by
  a Host change.
- **Host add has two separate CLI gates**, `--yes` and
  `--confirm-additional-host`. `executeHostAddition` rechecks the flag even though
  the plan passed it.
- **Adoption "exactly matches" means the same file set with byte-identical
  content, and executable bits are ignored.** Install still sets modes 755 and
  644. A symlink or non-regular file makes a tree unadoptable and unsafe.
- **Adoption never moves or copies.** A Skill adopted at a non-canonical location
  stays there. `adoptedPaths` and `installation.path` record it, and
  `classifyTrackedInstallation` marks it `nonCanonicalPath`, which requires an
  exact-path confirmation for any later update or removal. Adding a missing Host
  during adoption needs `--confirm-additional-host`.
- **`--yes` confirms overwrite and the external method on update, but not a
  non-canonical path.** Each such path needs its own `--confirm-path <relative>`.
  An unmatched `--confirm-path` is an error, never silently ignored.
- **Trust asymmetry.** The project manifest is repository-controlled, so a
  non-canonical install must be confirmed. The user-global state is written by
  Agent Depot, so `installationTrust` treats it as trusted and
  `classifyTrackedInstallation` skips validation there.
- **Backups and stage directories are never auto-pruned.** The inventory excludes
  them through `isTransientName` (`.agent-depot-backup-*`, `-update-*`,
  `-overwrite-*`, `.agent-depot-unmanaged-stage-*`, `*.tmp`).
- **Update is transactional only with an injectable `rename` adapter.**
  `updateProjectSkillTransaction` throws `update-unavailable` without one. It
  stages, renames the old target to a backup, then renames the stage in. Rollback
  restores and commit deletes the backup.
- **`requireConfirmation` is purely the `--yes` flag.** The CLI has no interactive
  prompt. The TUI supplies interactive confirmation instead.
- **Install writes with `flag: "wx"`** and rolls back created paths by recorded
  path identity (device, inode, birthtime, size), failing closed on a concurrent
  replacement.

## Open questions

- The TUI view rendering glue (`catalog-view.tsx`, `installations-view.tsx`,
  `updates-view.tsx`, `adoption-actions.ts`, `render.tsx`) was not read end to end.
  Only the logic seams were traced.
- `skill-discovery.ts` internals were not read. The digest algorithm is assumed to
  be sha256 because `parseInstallationBaseline` requires 64 hex characters.
- `executeSourceInstallationMethod` and the `process-runner.ts` no-shell execution
  details were not read.
