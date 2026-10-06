# Grounding: the App resource category

Traced from `src/app-flow.ts` and neighbours.

## Components

- `src/app-recipes.ts` parses and validates a recipe object into a typed
  `AppRecipe`. Defines `APP_GITHUB_PATTERN`, `APP_NPM_PATTERN`,
  `APP_SKILL_PATTERN`, `AppStep`, `AppVersion`, and `parseAppRecipe`.
- `src/app-schema.ts` holds `APP_RECIPE_SCHEMA`, a draft 2020-12 JSON Schema that
  mirrors `parseAppRecipe`, exposed through `app schema`.
- `src/app-flow.ts` is the core. `createAppOperations()` returns the
  `AppOperations` interface and owns loading, approval, inspection, lifecycle
  execution, and App state persistence.
- `src/app-cli.ts` holds `runAppCommand()`, `runLifecycle()`, and the result
  helpers.
- `src/app-version.ts` holds the strict SemVer comparator `compareAppVersions`,
  plus `normalizeAppVersion` and `sameAppVersion`.
- `src/app-latest.ts` holds `fetchAppLatest()`, which reads latest version from
  GitHub Releases or the npm registry, hard-limited and credential-free.
- `src/app-recipe-removal.ts` holds `planAppRecipeRemoval()` and
  `removeAppRecipe()` for safe recipe deletion. TUI only.
- `src/app-owned-skills.ts` holds `loadAppOwnedSkillFilter()` and
  `assertSkillNotAppOwned()`, which map recipe `skills` globs to exclusion
  matchers.
- `src/process-runner.ts` holds `runProcess()`, the one command-runner seam.
- `src/atomic-file.ts` holds `writeFileAtomically()`, a temp-sibling plus rename
  publisher used for every App state file.
- `src/project-manifest.ts` supplies `PROJECT_HOSTS` (`pi`, `claude`, `codex`,
  `opencode`) and `parsePortableInstallationMethod()` with its argv safety rules.
- `src/path-safety.ts` holds `assertNoSymlinkPath()`, used before unlinking recipe
  files.
- `src/source-state.ts` holds `defaultSourceStatePath()`, which anchors the state
  directory layout.
- `src/profile.ts`, `src/profile-export.ts`, and `src/profile-import.ts` carry
  recipes as portable profile `apps` entries.

## Flow

1. **Entry points.** `cli.ts:181` routes `agent-depot app …` to `runAppCommand`.
   `cli.ts:912-1023` (`runUpdate`) drives Apps in `update apply`. The TUI drives
   them through `tui/updates.ts`, `tui/installations.ts`,
   `tui/installations-view.tsx`, `tui/app-actions.tsx`, and
   `tui/sources-recipes.tsx`.
2. **Factory.** `createAppOperations(env)` (`app-flow.ts:77`) resolves `platform`,
   `home`, and `stateDirectory = path.dirname(defaultSourceStatePath(...))`. It
   then sets `directory = <state>/apps` for recipes, `receipts =
   <state>/app-approvals`, `installations = <state>/app-installations`, and
   `pendingUpdates = <state>/app-pending-updates`. It injects the `runner`,
   `fetch`, `resolveExecutable`, and `wslMountRoot` seams.
3. **Load.** `load(files?)` (`:155`) calls `read(file)` (`:129`), which does a
   `realpath`, reads bytes, parses JSON, runs `parseAppRecipe`, computes a sha256
   content hash, and sets `applicable` from `recipe.platform` against
   `windows`/`linux`/`darwin`. Directory listing filters `*.json` and sorts.
   `rejectDuplicates()` (`:143`) marks any duplicated applicable `recipe.name` as
   errored. When `files` is passed (validate, approve) the entries are re-derived
   from the registered load if the file sits inside the recipe directory.
4. **Approval.** `approve(entry)` (`:195`) re-loads and checks that hash and
   canonical path are unchanged, then writes `receipts/sha256(canonicalFile).json`
   containing `{hash}`, file mode `0o600`, directory mode `0o700`.
   `approvalStatus(entry)` (`:207`) is read-only and never resolves or runs
   commands. Approval invalidates on any content change, path or canonical change,
   or platform mismatch.
5. **Inspect.** `inspect(entry, cached?)` (`:227`) checks approval first, then
   resolves the executable on PATH, runs the version argv through `runner` with
   stdout capture, and extracts capture group 1 of `version.pattern`. A `cached`
   call short-circuits without running anything. `resolve()` (`:97`) walks PATH,
   realpaths for the WSL Windows-exe block, and returns the original candidate to
   preserve shims.
6. **Update check.** `checkUpdate` (`:250`) is inspect plus latest. An argv-style
   latest needs approval and a command run. `{github}` and `{npm}` go through
   `fetchAppLatest`. It compares with `compareAppVersions` and `sameAppVersion`
   into `current`, `update available`, or `unknown`. `checkAppUpdates` (`:461`)
   fans out per entry and isolates failures.
7. **Lifecycle plan.** `planLifecycle(entry, action, host?, loadedUpdate?)`
   (`:315`) goes through `planStep` (`:303`), which rechecks approval, picks the
   `install`, `update`, or `uninstall` step or the `setup`/`teardown` step for the
   given host, resolves argv, and freezes an `AppLifecyclePlan` with `cwd: home`
   and `environment` of `linux (WSL)` or the platform. Update adds
   `previousVersion` and `latestVersion`.
8. **Execute.** `executeLifecycle(plan, confirmed)` (`:362`) requires
   `confirmed`. `recheckPlan` (`:326`) re-derives the plan and diffs argv,
   executable, warning, manual, hash, cwd, and environment. With no `argv` it
   returns `manualFallback`. On a warning or a missing executable it also falls
   back. Otherwise it calls `runner(executable, argv.slice(1))`. Non-zero, a
   signal, or too much output becomes `failed` with the last 4 KiB of output. On
   success `recordOutcome(plan)` (`:333`) re-inspects to verify the installed
   version. Install and update write
   `<state>/app-installations/sha256(name).json` with `{name, recipeFile,
   installedVersion}`. Update rejects an unchanged version. Uninstall confirms
   `not installed` and then forgets the App. `manualFallback` (`:406`) writes a
   pending-updates baseline for manual updates, and `completeManual(plan, done)`
   (`:423`) consumes it and re-runs `recordOutcome` with `manual=true`.
9. **Recipe removal.** `planAppRecipeRemoval` (`app-recipe-removal.ts:39`) checks
   the file is inside `apps.directory`, captures device, inode, hash, and
   symlink-link identity, verifies the current recipe is unchanged, inspects
   install state, and refuses while the App is installed or tracked. It also
   refuses when the version command did not run. `removeAppRecipe` (`:71`)
   rechecks identity and installed state twice, then unlinks only the recipe path.
   Symlinks are removed as links.

## Boundaries

- Inputs are the `AppEnvironment` seams (`recipesDirectory`, `homeDirectory`,
  `platform`, `isWsl`, `wslMountRoot`, `runner`, `fetch`, `resolveExecutable`),
  recipe JSON files on disk, and profile files.
- Outputs are the `AppOperations` interface used by `cli.ts`, `tui/*`, and the
  profile modules. `checkAppUpdates` and `AppUpdateCheck` feed update batching.
  `assertSkillNotAppOwned` is called from `skill-install.ts` and
  `user-global-skill-inventory.ts` to block unmanaged adopt and remove of
  App-owned names. `loadAppOwnedSkillFilter` feeds the profile export exclusion
  and `scanUserGlobalSkillInventory`.
- `runProcess` is the single place a child process runs. It spawns with
  `shell: false`, standard streams of `ignore`/`pipe`/`pipe`, and optional 1 MiB
  stdout and stderr caps.

## Non-obvious

- **Two distinct gates.** Approval is a one-time, content-keyed receipt in
  `app-approvals/`. The per-invocation `--yes` or `confirmed` flag is separate.
  Approval is rechecked in `planStep` and again in `recheckPlan`.
  `executeLifecycle` never checks approval directly.
- **The receipt is keyed by `sha256(canonicalFile)`**, not by name. Renaming or
  moving a recipe invalidates approval even with identical content.
- **The installed record is keyed by `sha256(name)`.** Its `trackedApps` parser
  cross-checks `path.basename(installationPath(record.name)) === file` to catch a
  tampered filename, and warns rather than errors on an invalid record.
- **Windows executables under WSL.** A `/mnt/<letter>/…` target is blocked and
  surfaces as a plan `warning`, which forces `manualFallback` instead of running.
- **argv safety is enforced at parse time**, not at execution. `step()` and
  `version()` wrap argv in `parsePortableInstallationMethod` with `ARGV_RULES`. A
  recipe argv never carries `cwd`. cwd is always forced to the user home.
- **Recipe removal is TUI only.** There is no CLI command for it.
- **Manual steps are never executed.** A step with only `manual`, or an argv that
  cannot run, returns `manual required` with the text. For updates it persists a
  pending-updates baseline, which `completeManual` always clears, even when
  verification then fails.
- **State directory layout.** On Linux `~/.local/state/agent-depot/`, on Windows
  `%APPDATA%/Agent Depot/`. Under it live `apps/*.json`, `app-approvals/`,
  `app-installations/`, and `app-pending-updates/`. They sit beside `sources.json`
  but are outside the locked `SourceStateStore`. Each write is an independent
  `writeFileAtomically`, with no cross-process lock.
- **Duplicate name rule is platform-aware.** Only applicable recipes with the same
  name collide, and `rejectDuplicates` records an error rather than throwing, so
  `app list` shows it as invalid.

## Open questions

- `skill-adoption.ts` and `unmanaged-removal.ts` showed no direct
  `assertSkillNotAppOwned` match. The guard appears to live in `skill-install.ts`
  and `user-global-skill-inventory.ts`. The adopt flow was not fully traced to
  confirm every unmanaged mutation path is guarded.
- `tui/sources-recipes.tsx` and the `prepareUpdates` path in `tui/updates.ts` were
  not read end to end. Their interaction with `completeManual` is inferred.
