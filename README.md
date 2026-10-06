# Agent Depot

[**English**](README.md) · [Español](README.es.md)

Agent Depot is a cross-platform manager for the reusable resources that coding agents
use. It discovers Skills from Git Sources, installs them into one or more Hosts
(Pi, Claude Code, Codex and OpenCode), manages user-global Apps and host-native
Packages, keeps track of what it installed and updates it safely, all from a CLI or
an interactive TUI.

What it does:

- **Sources and catalog**: register Git repositories (plus the built-in
  `builtin:agent-depot` Source) and discover the Skills they contain.
- **Install Skills** user-global or per project, for several Hosts at once, pinned
  to a version or following the latest. A project manifest lets a fresh checkout
  reinstall the same Skills.
- **Updates**: check and apply updates in batch; every change is previewed first and
  needs explicit confirmation.
- **Existing installations**: report unmanaged Skills already on disk, adopt the
  ones that exactly match a Source, or remove them by explicit path.
- **Apps**: install, update and uninstall user-global applications through
  user-written App recipes that must be approved before they run.
- **Packages**: install, update and uninstall host-native bundles (Pi packages and
  Claude Code plugins) by delegating the lifecycle to each Host's own CLI and
  reading the installed version from the Host's own state files.
- **Profiles**: export your user-global Sources, Skill selections, App recipes and
  Package selections to a portable file and import them, add-only, on another
  machine.

Agent Depot never overwrites or deletes content without a preview and confirmation,
and refuses unsafe paths and links.

Requires Node.js >= 24 (Active LTS). The [interactive TUI](#interactive-tui)
needs an interactive terminal.

## Install

Agent Depot is published as the scoped package `@iseoane/agent-depot` and exposes the
`agent-depot` command. It requires Node.js >= 24.

```sh
# Run without installing
npx @iseoane/agent-depot --version
npx @iseoane/agent-depot tui
pnpm dlx @iseoane/agent-depot tui

# Or install globally
npm install --global @iseoane/agent-depot
pnpm add --global @iseoane/agent-depot
agent-depot --version
```

The examples below use the `agent-depot` command; `npx @iseoane/agent-depot <args>`
works the same way without a global install.

### Updating

`npx` may reuse a cached copy of an older version. Add `@latest` to force the newest
release:

```sh
npx @iseoane/agent-depot@latest tui
pnpm dlx @iseoane/agent-depot@latest tui
```

A global install is updated with the package manager that installed it:

```sh
npm install --global @iseoane/agent-depot@latest
pnpm add --global @iseoane/agent-depot@latest
```

A running Agent Depot never downgrades built-in Skills: a Skill installed by a newer
Agent Depot is reported as not updatable (update Agent Depot first).

## Usage

With the package installed (or via `npx @iseoane/agent-depot`). `agent-depot --help`
(also `-h` or `help`) prints the usage and exits 0; running it without arguments
or with an unknown command is a usage error and exits 1.

```sh
agent-depot source list
agent-depot source add https://github.com/example/skills.git
agent-depot source refresh git:<source-id>
agent-depot source refresh git:<source-id> --yes
agent-depot source remove git:<source-id> --yes
agent-depot source remove git:<source-id> --skill <id|path> --yes
agent-depot source migrate git:<old-source-id> git:<new-source-id> --skill <path> --yes
agent-depot discover builtin:agent-depot git:<source-id>
agent-depot install --scope project --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --yes
agent-depot install --scope user-global --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --yes
# Only for an explicitly reviewed, untracked real-directory conflict:
agent-depot install --scope project --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --overwrite --yes
agent-depot install --scope project --manifest --portable-v1 --yes
agent-depot update check --scope project
agent-depot update apply --scope project --all --yes
agent-depot update apply --scope user-global --skill 0 --yes
agent-depot skill remove <id|path>... --yes
agent-depot skill remove <id|path> --host <host>... --yes
agent-depot skill host add <id|path> --host <host>... --yes --confirm-additional-host
agent-depot uninstall --cli
agent-depot uninstall --skills --yes
agent-depot uninstall --unmanaged-skill <exact-global-path> --yes
agent-depot uninstall --data --yes
agent-depot app list
agent-depot app approve <name> --yes
agent-depot app install <name> --yes
agent-depot package list
agent-depot package discover <source-id>
agent-depot package inspect <source-id>::<bundle-path> --host <host>
agent-depot package approve <source-id>::<bundle-path> --host <host> --action install
agent-depot package install <source-id>::<bundle-path> --host <host> --yes
agent-depot package forget <source-id>::<bundle-path> --host <host> --yes
agent-depot update check --scope user-global --package <selection>
agent-depot export --out profile.json
agent-depot import profile.json --yes
agent-depot tui
agent-depot --version
```

GitHub directory URLs such as `https://github.com/cursor/plugins/tree/main/pstack`
are also supported: Agent Depot clones the repository, reads the URL's ref, and
only discovers Skills inside that directory. Skill paths stay repository-relative.
The full URL remains the Source identity, so an already registered directory URL
can simply be refreshed. The ref occupies one URL segment; encode any `/` in a
branch name as `%2F` (for example `tree/release%2Fstable/pstack`). An explicit
fixed-version ref overrides the URL ref while keeping the directory scope.

Catalog groups show repository names instead of opaque Git IDs. Catalog and
Installations start with all groups collapsed; use Enter or the right arrow to
open a group. A Catalog filter automatically expands matching Sources.

The TUI Catalog reports unavailable Sources individually and keeps other Sources
browsable. To create a missing mirror, go to Sources (`1`) and refresh with `r`;
opening the Catalog does not initiate network access.

Refresh first prints the registered URL as a preview. It requires explicit
`--yes` confirmation before any network access and otherwise fails closed. The
package-owned `builtin:agent-depot` Source is listed as read-only and cannot be
refreshed.

Source removal is user-global only and never reads project manifests or deletes
Source caches. It previews every dependent user-global Skill and keeps all of them
tracked by default. Pass `--skill <id|path>` for a selected subset or `--all` for
every dependent Skill. Numeric indexes are accepted for the dependent list, but a
literal digit-only Skill path takes precedence over its numeric index. Skill
deletion always requires `--yes`; adopted content and content that is locally
modified (or lacks a trusted baseline) receive warnings.
Preflight rejects unsafe paths, unexpected links, missing installations, overlapping
selected targets, and other inspection failures before changing the Source state or
deleting any Skill. A second preflight compares each target's content digest,
adoption flag, and modified status before the first deletion.

`skill remove <id|path>...` removes selected user-global managed Skills without
touching their Source. Each `<id|path>` is the exact Skill path or its final path
segment when that is unique; unknown or ambiguous selections fail before anything
changes. It previews every deletion (with adopted/modified warnings), requires
`--yes`, rechecks the targets, then deletes the files and their installation
records. It is user-global only: project installations and manifests are never
read or changed, and the Git cache is retained.

`skill host add <id|path> --host <host>... [--yes] [--confirm-additional-host]`
exposes an already installed user-global Skill to more Hosts without changing its
content or version, then records the new Hosts. Non-Claude Hosts share the
canonical `~/.agents/skills/<skill>` location and Claude is a symlink to it, so
only a missing Claude symlink is ever created. The preview lists the new
locations; because it exposes the Skill to more Hosts it needs both `--yes` and
`--confirm-additional-host`. It refuses a Claude location that already holds
anything other than the managed symlink, and a Skill that is not installed at the
canonical location (exposing it would require copying it).

`skill remove <id|path> --host <host>... [--yes]` removes only those Hosts. Only
the managed Claude symlink can be deleted this way; the canonical directory backs
every remaining Host (including the Claude symlink) and stays until the last Host
is removed. Removing every recorded Host is a full removal with the usual
adopted/modified warnings. The targets are rechecked before deleting and the
record is updated afterwards. Project installations are not affected.

To replace a Source URL, register the new Git Source first, then explicitly migrate
user-global identities with `source migrate <old-id> <new-id> (--skill <path>... |
--all) [--yes]`. Migration rewrites only selected user-global records: it never
moves physical installations or rewrites project manifests. Identity collisions are
rejected. Fixed version policies are retained only when the replacement Source
provides matching commit evidence; old resolved Source evidence is otherwise
removed. Content baselines remain tied to the unchanged installation, and
user-provided methods are retained for review rather than rewritten.

## Uninstall choices

Uninstall is user-global only and never reads or changes project manifests. The
choices are independent: `--skills` removes all managed user-global Skills,
`--unmanaged-skill <exact-global-path>` removes only explicitly selected unmanaged
real directories below `~/.agents/skills` or `~/.claude/skills`, `--data` removes
the catalog/configuration state file, and `--cli` prints a package-manager handoff
for removing the persistent CLI. Unmanaged removal never searches or infers a
Source, refuses symlinks, transient/backup paths, invalid trees, managed paths,
and overlaps, and permanently deletes only after moving the unchanged tree to
same-parent staging. Skills and catalog data are preserved when their flags are
omitted. Removing Skills reconciles their installation records; removing data
while retaining Skills leaves those Skills untracked. Every filesystem deletion
requires `--yes` after the complete preview, and the unmanaged preview warns that
Agent Depot cannot guarantee recovery without a resolvable Source. Immediately
before each destructive removal, Agent Depot rereads managed installation records
and fails closed if they changed or now claim the selected path. The source-state
store serializes cooperating updates, but a non-cooperating process can still race
between the final check and filesystem rename/delete; staging failures restore the
original path when the result is known and otherwise retain the staged path with an
uncertain-status error. Agent Depot never invokes or infers a package manager, and
Git Source caches are retained. `uninstall --cli` prints the exact commands
(`npm uninstall --global @iseoane/agent-depot`, `pnpm remove --global @iseoane/agent-depot`);
`npx`/`pnpm dlx` runs need no uninstall, only a cache entry.

## Batch updates

Check either independent installation scope before applying updates:

```sh
agent-depot update check --scope project
agent-depot update check --scope user-global
```

The check reports `Updateable`, `Current`, and `Unknown` managed Skills separately. `Unknown`
means a recorded managed selection could not be assessed safely (for example, its
Source or version evidence is unavailable); it remains managed but is not
updateable. For `--scope user-global` only, the check also reports `Unmanaged`
real Skill directories found at exact absolute locations below the supported
user-global roots. These are not update candidates, are not included in the
managed status counts, and are never looked up through a Source. Project checks
do not inventory or report unmanaged directories.

Skipped or unsafe global entries are shown separately with guidance and are not
Unmanaged entries or removal candidates. They may be symlinks, unsafe roots or
Skill files, or transient Agent Depot paths; inspect them manually. The later
unmanaged-removal workflow requires its own exact-path preview and explicit
confirmation.

Apply all updateable Skills or select one or more by their printed update ID, numeric
index, or an unambiguous Skill path:

```sh
agent-depot update apply --scope project --all --yes
agent-depot update apply --scope user-global --skill 0 --yes
agent-depot update apply --scope user-global --package git:<source-id>::pi:. --yes
```

For `--scope user-global` only, the check also assesses every recorded Package and
`update apply` accepts repeatable `--package <selection>` or includes updateable
Packages under `--all`. A Package with `unknown` version status is never offered as
an update. Packages run after Skills and Apps, each selected Package previews its
frozen plan, and a Package whose update receipt is missing is approved first. Project
scope never reads or selects a Package.

A Skill tracked at a non-canonical project path (outside `.agents/skills/<name>` and
`.claude/skills/<name>`) is repository-controlled, so `--yes` alone does not update it. The
preview prints the relative path; repeat it with `--confirm-path` (once per such path):

```sh
agent-depot update apply --scope project --all --yes --confirm-path vendor/alpha
```

Applying always previews each selected candidate first. `--yes` is required and
confirms each candidate independently; without it, no files or state are
changed. Modified installations are called out and are never overwritten
without that explicit confirmation. External update commands show their exact
argument vector, working directory, target, declared changes, and a warning
that side effects cannot be verified or rolled back. Unknown-version Skills are
reported but cannot be selected for application, and independent failures are
summarized after the remaining candidates finish.

`discover` requires one or more Source IDs on every invocation. Use
`source list` to find registered IDs. It reads the current cached Git mirror
HEAD without refreshing it, so run `source refresh <id> --yes` first when a
mirror is unavailable or stale. It prints one tab-separated `Candidate:` line
per recognized Skill in this format:

```text
Candidate: <source-id>\t<skill-path>\t<name>\t<description>
```

Discovery only presents candidates. It does not persist Source selection,
select candidates, or install anything automatically.

## User-global installation

User-global installations use the same canonical Host locations under the user
home directory (`.agents/skills/<skill>` and, when requested, a Claude symlink
at `.claude/skills/<skill>`). They are independent from project manifests and
are recorded in the shared per-user Source state, so separate CLI invocations
reuse the same installation records. The selected Source, Skill, Hosts, and
actual adopted or installed location are previewed before `--yes` confirmation.

A direct project or user-global install can configure its install method before
first installation with `--method <json>`. The value must be one strict JSON
method object, for example:

```sh
agent-depot install --scope user-global --source builtin:agent-depot \
  --skill architecture --host pi --version latest \
  --method '{"kind":"command","argv":["node","scripts/install.mjs"],"cwd":"tools"}' \
  --portable-v1 --yes
```

The method is stored as `methods.install`, takes precedence over Source metadata,
and is executed from an argument vector without a shell. The command and
intended changes are previewed before confirmation. This option only configures
the install method; update execution is not part of this lifecycle.

## Project installation

Project installation requires an explicit `--scope project`, Source ID, Skill
path, one or more `--host` values (`pi`, `claude`, `codex`, or `opencode`), and
a version policy (`--version latest` or `--version fixed:<value>`). External
Sources require a fixed 40- or 64-character Git commit. For the built-in
Source, `latest` tracks the installed Agent Depot package, while a fixed policy
is accepted only when its value exactly equals that package's current version;
other values fail closed because the requested package version cannot be
reproduced. A manifest written by another Agent Depot stays loadable: a built-in
Skill pinned to a different version shows as unknown in `update check` ("pinned
to Agent Depot X; running Y") and is skipped by `install --manifest`, while the
other Skills keep working. The built-in Source does not support `--ref`, and the CLI rejects it
explicitly. External `latest` may track an explicit mutable safe ref, but an
immutable commit ref must use a fixed policy matching that commit. The
`--portable-v1` flag requires the validated portable format rule; compatibility
is derived from source bytes and exclusions rather than trusted from a caller
assertion. A skill-relative `agents/` directory is supported: its files remain
inside the selected Skill tree and are installed at
`.agents/skills/<skill>/agents/`, rather than being treated as a Host-level
`agents/` directory. Other Host-specific top-level directories such as
`.claude`, `.codex`, `.opencode`, `.pi`, `extensions`, `plugins`, and `mcp`
remain outside the portable V1 format.

The CLI reads the selected immutable Skill tree before asking for `--yes`.
Portable incompatibilities are rejected before confirmation or any write, with
the rejected source path and reason shown in the error. The inspected destination
identity and content are carried through confirmation and checked again immediately
before replacement; drift aborts without moving the target. A successful preview
lists the exact selected files, including supported skill-relative agents
files, and only a confirmed `--yes` proceeds to installation.

A confirmed installation writes `agent-depot.json` in the project root. The
manifest stores built-in identity or an external canonical URL, Skill path,
version policy, and Hosts, so `install --scope project --manifest` can resolve
it without the global Source catalog. Portable manifests reject local path
Sources because their identity is not independently resolvable. External Git
Sources are refreshed only
after confirmation.

The complete Skill tree is copied byte-for-byte and executable modes are preserved.
Before confirmation, existing Host locations are inspected and conflicts are shown.
Identical content is adopted in place; a Skill already recorded as managed must be
changed with `update apply`, not a repeat install. By default, no existing path is
overwritten. For an untracked, real directory whose content differs, replacement
requires both `--overwrite` and `--yes`:

```sh
agent-depot install --scope project --source builtin:agent-depot \
  --skill architecture --host pi --version latest --portable-v1 --overwrite --yes
```

The preview is explicit about this distinction: without `--yes`, zero files or
installation state are changed; with both flags, it reports that the target will
be replaced and shows the `.agent-depot-backup-<generated-suffix>` backup pattern.
The same contract applies to `--scope user-global`. Symlinks, special files,
unsafe trees, ambiguous Claude locations, and races between preview and mutation
fail closed. Replacement first moves the exact original directory to a persistent
backup beside the installation, then installs the immutable preview tree. The CLI
prints the backup path; successful backups are never deleted automatically. Filesystem
replacement and manifest/global-state failures are restored in-process before the
error is returned. Rollback verifies the retained backup and replacement content
before deleting the replacement and fails closed when either has changed. These are
the strongest portable filesystem checks available, not an atomic cross-process
compare-and-swap: an external writer can still race after the final check, so Agent
Depot does not claim to serialize concurrent writers. This is not crash recovery: a
process crash after the original is moved can leave the retained
`.agent-depot-backup-*` directory with no guaranteed replacement state. Stop the CLI,
inspect the backup and target, and manually rename the retained backup back to the intended installation path when recovery is needed;
then rerun the install. External installation methods run only after the filesystem
and selected-scope state transaction succeeds.
Claude is exposed through a symlink to the canonical `.agents/skills/<skill>`
installation.

## User-provided installation methods

A project selection may persist portable install and future-update methods in
its `methods` field:

```json
{
  "source": { "kind": "external", "url": "https://example.com/skills.git", "ref": "main" },
  "path": "portable/example",
  "version": { "policy": "latest" },
  "hosts": ["pi"],
  "methods": {
    "install": { "kind": "command", "argv": ["node", "scripts/install.mjs"], "cwd": "tools" },
    "update": { "kind": "command", "argv": ["node", "scripts/update.mjs"] }
  }
}
```

The same selection shape is stored under `userGlobalInstallations` in the
shared user-global `sources.json` state. `methods.install` takes precedence
over a method declared by the selected Source; the Source method is used only
when no configured install method exists. The configured `update` method is
currently persisted only; update execution belongs to the update workflow.

Before any configured or Source method runs, the CLI previews the exact argv,
resolved project or user-global cwd, selected files, and intended installation
locations. It requires explicit `--yes`; refusing the preview performs no
installation and runs no method. Methods are argument vectors, never shell
strings: they must use one portable command with no OS-specific variants, and
shell interpreters and shell syntax are rejected. Configuration must not contain
credential literals. Validation rejects obvious credential patterns on a
best-effort basis; it cannot detect every secret, so users remain responsible
for avoiding secrets in arguments or repository files.

A confirmed method runs as arbitrary child-process code with no sandbox. It may
change any filesystem location or external system available to that process;
Agent Depot cannot preview or roll back those side effects. The managed Skill
installation and manifest/state are persisted before method execution, and a
method failure retains those records. Source metadata is read from the same
immutable tree snapshot shown in the preview, not from a mutable latest re-read.

A Source may declare an installation method only through an explicit JSON
metadata file inside the selected Skill (`.agent-depot.json`,
`agent-depot-method.json`, or `installation-method.json`), never from
`SKILL.md` prose. The file may contain either the method object or
`{ "method": { "kind": "command", "argv": ["executable", "arg", ...],
"cwd": "optional/project-relative-directory" } }`. The executable must be a
bare safe command name and `cwd` must remain below the project root after
realpath resolution. A confirmed method still goes through compatibility
validation, canonical installation, and the Claude symlink path. Method-
containing batch installs are refused because arbitrary child-process side
effects are non-rollbackable. Manifest entries that identify an external local
path are refused by the Git-only resolver with an actionable unsupported-source
error; URL Sources remain self-contained and resolvable on a fresh machine.

## Interactive TUI

```sh
agent-depot tui
```

The TUI is an [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
front end over the same operations as the CLI. It needs Node.js >= 24 and an
interactive terminal; otherwise `tui` fails with an error. Switch views with
`1`-`5`, quit with `q` (not while a prompt is open). Every list scrolls when it is
taller than the terminal. `j`/`k` or the arrow keys move.

| View | Purpose |
| --- | --- |
| 1 Sources | Skill Sources and user-owned App recipes in one list, with `skills`/`app` kinds and contextual actions. |
| 2 Catalog | Skills that can be installed: those not installed yet, as Source, then Skills. Each Source also shows a Packages group, and the Skills a bundle owns are marked and dimmed. |
| 3 Installations | What is on disk: managed installations (user-global and project), Package selections and unmanaged user-global skills. |
| 4 Updates | Managed skills and Packages with a newer version available, for user-global and project scope. |
| 5 Import/Export | Transfer portable user-global Source choices, Skill selections, App recipes and Package selections. |

Keys per view (prompts also accept `Esc` to cancel and `y`/`n` to confirm):

| View | Keys |
| --- | --- |
| Sources | `j`/`k` move through Skill Sources and App recipes (no Tab section switch). `Enter` opens the Catalog for a Skill Source or previews/approves an App recipe. `n` adds a Source or guides recipe authoring; `r` refreshes Sources or reloads recipe status; `d` removes. `space`/`a` mark Skill Sources only. |
| Catalog | `Enter`/arrows expand and collapse, `space` mark, `a` mark all listed, `i` install the marks (or the highlighted skill), `/` filter, `s` toggle one Source or all (when opened from a Source) |
| Installations | `Enter`/arrows expand and collapse, `u` uninstall (all Hosts or chosen Hosts) or remove an unmanaged skill, `h` or `i` add Hosts to an installation, `A` or `Enter` adopt an unmanaged skill, `space` marks a leaf and `a` marks all visible leaves: with marks, `u` and `h` act on all of them with one combined preview and one confirmation (project installations are skipped with a reason). On a Package row: `i` or `Enter` approve the install declaration, `U` update, `u` uninstall, `f` forget the selection record. Package rows are not markable for bulk actions. |
| Updates | `space` mark, `a` mark all, `t`/`p`/`g` show all, project or user-global, `Enter` preview the marks, `r` check again, arrows fold the "cannot assess" line. A marked Package joins the batch and is approved before its update runs. |
| Import/Export | `e` export, `i` import; enter a file path, `space` toggle choices, `a` toggle all, `Enter` preview, `y` apply; `j`/`k` scroll previews and results |

Removing an App recipe checks its approved version command and tracked state.
If the App is installed or tracked, the TUI offers the existing uninstall flow;
`n` cancels removal and a failed uninstall keeps the recipe. After verified
uninstall (or when not installed), a separate preview confirms deletion of only
the recipe file or symlink. App data and Host configuration are not implicitly
deleted. Invalid recipes must be repaired before their App state can be checked.

Safety model:

- Nothing is written before a preview and an explicit `y`. Exposing a skill to an
  additional Host needs a second, separate confirmation, like `--confirm-additional-host`.
- An install refreshes its Git Source before the preview, so the content you
  confirm is the content that is applied. The Updates view refreshes
  the Git Sources in use when you enter it and on `r`.
- A Package action previews the frozen declaration and the exact Host commands.
  `y` approves that action's receipt before the Host command runs; `n` or `Esc`
  cancels without approving or running anything. Listing and reloading Packages
  never run a Host command.
- The built-in Source is fixed: it is shown as an unselectable row and cannot be
  refreshed or removed.
- Removal is user-global only. Project installations are listed, but project
  uninstall is not supported (`u` on a project row shows a message).
- Unmanaged skills are removed only from the paths listed in the preview. A symlink
  is removed as a link; its target is never touched.
- Batch installs and removals apply item by item; one failure does not stop the
  others and each item reports its own result.

See [CONTEXT.md](https://github.com/iseoane/agent-depot/blob/main/CONTEXT.md) for the domain terms and [docs/adr](https://github.com/iseoane/agent-depot/tree/main/docs/adr) for the
decisions behind the TUI.

## Configuration and cache

The Source catalog and user-global installation records are stored together at:

- Linux and other Unix platforms: `$XDG_STATE_HOME/agent-depot/sources.json`,
  or `~/.local/state/agent-depot/sources.json` when `XDG_STATE_HOME` is unset.
- Windows: `%APPDATA%/Agent Depot/sources.json` (falling back to the user
  `AppData/Roaming` directory).

Git mirrors are cached separately from the catalog:

- Linux and other Unix platforms: `$XDG_CACHE_HOME/agent-depot/git-sources`,
  or `~/.cache/agent-depot/git-sources`.
- Windows: `%LOCALAPPDATA%/Agent Depot/git-sources`.

## Limitations

Packages are limited to the Pi and Claude Code Hosts in V1. Codex and OpenCode
plugins, npm-sourced Pi packages, project-scoped Packages and external Claude
marketplace sources are deferred, and a fixed-version Claude selection is refused;
see [Packages](#packages).

Only Git repository URLs using `git:`, `http:`, `https:`, or `ssh:` are
accepted. Refresh uses the registered URL and runs Git with argument arrays,
without a shell. It creates or fetches a bare mirror, explicitly synchronizes
all refs, and prunes deleted refs; it does not check out files, install skills,
or choose Sources automatically. Network access is required for a confirmed
refresh.

## Development

From a source checkout, build and run the CLI directly:

```sh
pnpm install
pnpm build
node dist/src/cli.js --version
```

## Static analysis

[Fallow](https://docs.fallow.tools) 3.30.0 runs through `npx --yes fallow@3.30.0`
(pinned, no dependency installed) and reads `.fallowrc.json`, which defines the
entry points and the module-layer boundaries (`cli` -> `tui` -> `application`
-> `core` -> `infrastructure`; imports may only point downward, and `cli` may
also use the lower layers directly). `scripts/**` forms an isolated `tooling`
zone. Every source file must belong to a zone; App and Profile modules sit in
`application`, except `atomic-file.ts` in `infrastructure`.

- `pnpm audit:dead-code`: unused files, exports and dependencies, plus
  boundary violations. Must be clean.
- `pnpm audit:dupes`: code duplication (threshold 6%).
- `pnpm audit:health`: complexity and CRAP scores using real coverage; fails
  when the health score drops below 85.
- `pnpm audit:all`: runs the three checks in order.
- `pnpm test:coverage`: runs the tests with built-in V8 coverage
  (`NODE_V8_COVERAGE`, source maps) into `coverage/v8`, which Fallow reads.
  It rebuilds `dist/` with source maps; no extra dependencies are needed.

## User-global App recipes

Place user-owned JSON recipes in `apps/` next to the per-user `sources.json`
(Linux/WSL: `${XDG_STATE_HOME:-~/.local/state}/agent-depot/apps`; Windows:
`%APPDATA%\Agent Depot\apps`). Recipes are never rewritten or supplied by Sources.

```sh
agent-depot app schema
agent-depot app validate /path/to/example.json
agent-depot app list
agent-depot app approve example --yes
```

Validation previews every declared argv and its resolved executable but never
approves recipes (`validate --yes` is rejected). Review the preview before using
`app approve <name> --yes`: approval authorizes version commands, not just
read-only behavior. Private, atomically written approval receipts live in sibling
`app-approvals/` and are keyed to the canonical file path and exact content hash.
Changed bytes require approval again; restoring approved bytes restores approval.
`app list` never approves recipes. Invalid recipes are shown with
reasons; validation exits non-zero for invalid recipes. Other-platform recipes
are reported as not applicable and never executed. WSL counts as Linux and never
runs executables whose realpath is under `/mnt/<drive>/`; it skips those PATH
candidates while looking for Linux executables. Commands spawn the PATH candidate
rather than the realpath so shims and multicall binaries retain their identity.

Required fields are `name`, `install`, `update`, `uninstall`, and `version`.
Lifecycle steps contain `argv`, `manual`, or both; manual text is never executed.
`version` contains safe no-shell `argv` and a JavaScript regex `pattern` with one
capture group. Commands run from the user's home directory. An unsuccessful or
unresolvable version check means not installed. The schema describes structure;
`app validate` additionally enforces argv safety and regex semantics.

### Install, update and uninstall

```sh
agent-depot app install example          # preview only; exits non-zero until confirmed
agent-depot app install example --yes
agent-depot app update example --yes
agent-depot app uninstall example --yes
agent-depot app setup example --host pi --host codex --yes
agent-depot app teardown example --host pi --yes
```

Each step previews its argv/manual text, resolved executable, home working
directory and environment. Manual fallback occurs only when a process cannot
launch, never after a non-zero exit (reported with stdout/stderr). Run the shown
manual instructions yourself, then attest completion without rerunning argv:

```sh
agent-depot app install example --manual-done --yes
agent-depot app uninstall example --manual-done --yes
```

`--yes` alone does not attest manual completion. Install records a version only
when the version check succeeds. Uninstall retains tracking while version still
succeeds; `agent-depot app uninstall example --forget --yes` explicitly removes
tracking without running any recipe command, even if the recipe is gone.
Atomic per-App records live in sibling `app-installations/`. Uninstall does not
implicitly run Host teardown.

`app list` and `update check --scope user-global` resolve latest versions from
GitHub Releases, npm, or approved `latest.argv`. Missing or failed lookups are
unknown, never offered as updates. Public HTTP requests send no credentials,
reject redirects, cap responses at 1 MiB and time out after five seconds.

```sh
agent-depot update apply --scope user-global --all --yes
agent-depot update apply --scope user-global --skill 0 --app example --yes
agent-depot app update example --manual-done --yes
```

`--all` includes Apps and Skills; repeat `--app <name>` to select Apps alongside
Skills. App updates run **after Skills** in the same batch. Apps are user-global
only; `--all --scope project` skips Apps. Every selected step is previewed before the
batch confirmation; independent failures do not stop the remaining updates.
Manual batch outcomes are completed separately using `app update --manual-done`.
Updates record the version confirmed by the recipe's version command, not the
registry response. Updates require a changed version; unchanged versions fail
without rewriting installed tracking. Leading `v` and SemVer build-metadata-only
changes count as unchanged, just as in availability checks. Successful results show
`installed <old> -> <new> (latest <latest>)`, even when new differs from latest.
A confirmed manual update preview/fallback saves private version evidence in
sibling `app-pending-updates/`, so a later `--manual-done` invocation can compare
against the pre-update version. An attested manual completion consumes this
evidence even on failure; get a fresh confirmed preview before retrying.

Strict SemVer comparison ignores a leading `v`, orders prereleases and does not
offer a downgrade when installed is at or ahead of latest. Non-SemVer versions
use opaque inequality and **may offer a downgrade**. GitHub `/releases/latest`
excludes drafts and prereleases; npm uses package metadata's `dist-tags.latest`.
`app list` checks Apps concurrently, preserving listing order. One App check
failure does not hide other Apps or Skill updates. Lookup failures show reasons
(redirect, rate limit, HTTP status, timeout, oversized or invalid response).


App lifecycle commands are non-interactive: stdin is ignored (EOF), as in the
existing Skill command runner, and there is no execution timeout. Recipes must
use non-interactive flags; installers requiring a terminal belong in `manual`
steps. EOF lets stdin-based prompts fail rather than wait for input, but a
process ignoring EOF can still hang; cancel it manually. Captured App stdout
and stderr are each capped at 1 MiB; failures show only their last 4 KiB.

App setup/teardown accepts only Hosts declared for that action. All selected steps
are previewed before execution; each Host gets an outcome and failures do not stop
remaining Hosts. For manual completion, rerun the selected Host with
`--manual-done --yes`. This checks the App version, not Host wiring. Host actions
never change installed-App tracking.

## Packages

A Package is a host-native bundle discovered inside a registered Source: a Pi
package (a `package.json` with a `pi` key, or the conventional `extensions/`,
`skills/`, `prompts/` and `themes/` directories) or a Claude Code plugin (a
`.claude-plugin/plugin.json` bound by an in-repo `.claude-plugin/marketplace.json`).
One repository can be both, as `pstack-claude` is. V1 supports the Pi and Claude
Code Hosts only; Codex and OpenCode packaging, npm-sourced Pi packages and
project-scoped Packages are deferred.

Agent Depot does not copy a bundle's contents. It reads the bundle manifest into a
typed component inventory, derives the Host's own commands from that declaration,
runs them through the no-shell command runner after approval, and reads the
installed version back from the Host's state files. The Host owns what is
installed. Agent Depot owns the selection record and the receipt for what it
delegated. A bundle's own Skills are never offered for adoption or installed a
second time, because they stay under the Skill engine's canonical locations.

### Add a Source and discover its bundles

Discovery reads the cached Git mirror and never refreshes it. The first discovery
of a Source whose mirror is missing fails until you refresh that Source:

```sh
agent-depot source add https://github.com/michael-denyer/pstack-claude.git
agent-depot source list
agent-depot source refresh git:<source-id> --yes
agent-depot package discover git:<source-id>
```

`package discover` prints one line per bundle in the Source plus its component
inventory. `pstack-claude` yields a Pi bundle at the repository root and a Claude
bundle from its in-repo marketplace:

```text
Package git:<source-id>::pi:.: pstack
Package git:<source-id>::claude:plugins/pstack#pstack: pstack
```

Each component line names a kind, an ownership (`skill-category` or `host-only`),
an effect and the declared paths. Agent definitions and MCP servers appear as
`host-only`: Agent Depot reports them and leaves them to the Host.

### Select, approve and run a lifecycle action

A selection is `<source-id>::<bundle-path>` plus `--host`, or a host-qualified
`<source-id>::<host>:<bundle-path>`. A Claude bundle path ends in `#<plugin-name>`
when the Source offers more than one plugin.

`approve` is per action. It writes the receipt for the exact declaration of that
one action, so approving `install` does not authorize `update`. `--yes` confirms
execution and never substitutes for approval. Planning a lifecycle action
refreshes the selection's Git Source first, so the previewed manifest is the one
the commands derive from.

```sh
# Pi package at the repository root
agent-depot package inspect git:<source-id>::pi:. --host pi
agent-depot package install git:<source-id>::pi:. --host pi
agent-depot package approve git:<source-id>::pi:. --host pi --action install
agent-depot package install git:<source-id>::pi:. --host pi --yes

# Claude Code plugin from the in-repo marketplace
agent-depot package inspect git:<source-id>::claude:plugins/pstack#pstack --host claude
agent-depot package approve git:<source-id>::claude:plugins/pstack#pstack --host claude --action install
agent-depot package install git:<source-id>::claude:plugins/pstack#pstack --host claude --yes
```

The `install`, `update` and `uninstall` commands print the full preview, then exit
non-zero until both the action's receipt exists and `--yes` is given. The preview
shows the resolved origin and commit, the descriptor, the component inventory with
ownership and effect, every Host command with its resolved executable, the
recorded coordinates the action can change (`affects`), the working directory, the
environment, and any warning. Immediately before execution, Agent Depot re-derives
the declaration and stops with `stale plan` if the manifest, commit, install
identity or ordered commands changed since the preview. When the Host already
reports the bundle installed, the plan runs no command and only records the
selection.

The Host commands for the two V1 Hosts:

| Host | Install | Update | Uninstall |
| --- | --- | --- | --- |
| Pi | `pi install <source>` | `pi update <source>` | `pi remove <source>` |
| Claude Code | `claude plugin marketplace add <source>`, then `claude plugin install <plugin>@<marketplace>` | `claude plugin marketplace update <marketplace>`, then `claude plugin update <plugin>@<marketplace>` | `claude plugin uninstall <plugin>@<marketplace>` |

Agent Depot omits the `marketplace add` step when the Host already knows the
marketplace, and always names the marketplace on the scoped update verb. Every V1
action affects only its own selection.

### Installed state, versions and removal

`package list` shows every recorded selection with its install id and the version
evidence Agent Depot recorded. Live evidence comes from
`~/.pi/agent/settings.json` and `~/.claude/plugins/installed_plugins.json`, which
Agent Depot reads and never writes. A missing Host file is an empty view. A
drifted or undecodable file leaves the affected lookup `unknown` and never throws.
An unversioned Pi git package is reported as `unknown`, never as `current`.

An update records a new version only when the Host state changed in a way Agent
Depot can verify, meaning the two observations agree on a version or a
hexadecimal commit and differ, or the Host went from nothing installed to
installed. An unverifiable update fails and leaves the record untouched. Uninstall
delegates the Host command and then drops the selection record:

```sh
agent-depot package approve git:<source-id>::pi:. --host pi --action uninstall
agent-depot package uninstall git:<source-id>::pi:. --host pi --yes
agent-depot package forget git:<source-id>::pi:. --host pi --yes
```

`forget` removes only the Agent Depot selection record. It runs no Host command
and leaves the Host install as it is.

### Package limits

- A fixed-version Claude selection cannot be delegated. `claude plugin install`
  takes `<plugin>@<marketplace>` and has no pin slot, so planning a Claude
  `install` or `update` with a `fixed` version policy fails closed instead of
  claiming a pin the Host would ignore. Use `latest` for a Claude selection, or a
  fixed pin for a Pi selection, until a supported Claude pin form is verified.
- A Claude plugin with no in-repo marketplace binding is reported but not
  installable.
- Agent Depot does not read Host CLI prose output, including `pi list`. Installed
  evidence comes from the Host state files only.

## Export a user-global Profile

Export portable choices to another machine or keep them in git:

```sh
agent-depot export > profile.json
agent-depot export --out profile.json
agent-depot export --no-apps --source <source-id> --skill doctor-md-agents
agent-depot export --no-sources --no-skills --app my-tool --app another-tool
agent-depot export --no-packages --package git:<source-id>::pi:.
```

Everything portable is selected by default. `--no-sources`, `--no-skills`,
`--no-apps` and `--no-packages` exclude blocks; repeatable `--source <id|url>`,
`--skill <path|name>`, `--app <name>` and `--package <selection>` restrict each block
independently. Unknown selections and combining a block's inclusion filter with its
`--no-*` flag are errors.

Stdout contains JSON only; stderr shows the preview and exclusion reasons.
`--out` requires a new file (existing files and symlinks are not replaced).
Profiles contain canonical Git URLs with discovery inclusion, recorded Skill
version policies/Hosts/user methods, complete App recipes, including recipes for
other platforms, and Package selections as declarations only: their Source, host
coordinates and version policy. CLI export always writes `included: true`; discovery choices are transient, while
the TUI may pass explicit inclusion choices to the shared export core.
Export neither refreshes Sources nor runs App commands, and a Package receipt never
travels in a Profile.

Local paths and obvious credentials are not portable. Nonportable/invalid items
are excluded with reasons, as are unmanaged/App-owned and project Skills,
installation locations/evidence, approval receipts, installed-App state, pending
updates and Package receipts/installed state. Free-text recipe portability checks
are conservative; review
profiles before sharing them—arbitrary secrets cannot be detected automatically.

## Import a user-global Profile

Preview first, then explicitly confirm the same selection:

```sh
agent-depot import profile.json
agent-depot import profile.json --yes
agent-depot import profile.json --no-apps --skill doctor-md-agents --yes
```

Import uses the same independent block/name filters as export, including
`--no-packages` and `--package <selection>`. It reports **add**,
**same** (skipped), and **conflict** (difference shown, skipped). Without `--yes`,
nothing is written. Existing choices and conflicting files are never replaced.
A profile produced by a newer Agent Depot version gives a warning, not an error.

Confirmed additions run in order: Source registration, user-global Skills through
normal refreshed install previews and safety checks, then App recipes, then Package
selections. Recorded Hosts, version policies and user methods are retained. Even
without `--yes`,
each add-Skill preview shows its Source, Hosts, version policy and full argv for
every user-provided method, marked as running only after confirmation. The normal
install preview still appears before execution. Each failure is reported independently and remaining items
continue; any failed item makes the command exit non-zero.

A Package selection is a selection only. Import replays it through the flow's
`select` action, which writes a receipt for that action alone, whose declaration
carries no argv. No install or update is authorized and no Host command runs, so
import never installs a Package.

Recipes, including those for other platforms, arrive **unapproved** in `apps/`.
A same-name destination recipe blocks import only when its platform overlaps the
incoming recipe: equal platforms overlap, and a missing platform overlaps every
platform. Disjoint platform recipes can both be added. Invalid recipe JSON uses
its raw name and platform for the same check; unknown-name files are reported
with read/parse details without blocking unrelated Apps. A profile cannot contain
same-name recipes whose platform applicability overlaps. Import never installs Apps or runs
recipe commands. Review and approve applicable
recipes with `agent-depot app approve <name> --yes` before using their lifecycle
commands. Source discovery inclusion remains a transient frontend choice, not a
persisted change to an existing Source. Skills carry their own Source identity,
so omitting their Source block does not force registration; the preview names
unregistered Sources that will be fetched without registering. Existing Source
rows explain when discovery inclusion differs but is not imported.

The **5 Import/Export** TUI tab offers grouped checklists and the same shared-core
previews as the CLI. Exclusions and conflicts cannot be selected. Export creates
a new file only; empty exports write nothing (CLI reports an error). Import adds missing choices without replacing existing ones.
Imported recipes remain unapproved and Apps are never installed by import.
Imported Package selections are recorded without installing a bundle and without
running a Host command.
