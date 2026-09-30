# Agent Depot

Agent Depot keeps a global catalog of Git Sources for future skill discovery.

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
agent-depot tui
agent-depot --version
```

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
```

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
`1`-`4`, quit with `q` (not while a prompt is open). Every list scrolls when it is
taller than the terminal. `j`/`k` or the arrow keys move.

| View | Purpose |
| --- | --- |
| 1 Sources | Where skills come from: the fixed built-in Source plus registered Git Sources. |
| 2 Catalog | Skills that can be installed: those not installed yet, as Source, then Skills. |
| 3 Installations | What is on disk: managed installations (user-global and project) and unmanaged user-global skills. |
| 4 Updates | Managed skills with a newer version available, for user-global and project scope. |

Keys per view (prompts also accept `Esc` to cancel and `y`/`n` to confirm):

| View | Keys |
| --- | --- |
| Sources | `space` mark, `a` mark all, `Enter` open the Source in the Catalog, `n` add a Git Source, `r` refresh the marked (or highlighted) Sources, `d` remove |
| Catalog | `Enter`/arrows expand and collapse, `space` mark, `a` mark all listed, `i` install the marks (or the highlighted skill), `/` filter, `s` toggle one Source or all (when opened from a Source) |
| Installations | `Enter`/arrows expand and collapse, `u` uninstall (all Hosts or chosen Hosts) or remove an unmanaged skill, `h` or `i` add Hosts to an installation, `A` or `Enter` adopt an unmanaged skill, `space` marks a leaf and `a` marks all visible leaves: with marks, `u` and `h` act on all of them with one combined preview and one confirmation (project installations are skipped with a reason) |
| Updates | `space` mark, `a` mark all, `t`/`p`/`g` show all, project or user-global, `Enter` preview the marks, `r` check again, arrows fold the "cannot assess" line |

Safety model:

- Nothing is written before a preview and an explicit `y`. Exposing a skill to an
  additional Host needs a second, separate confirmation, like `--confirm-additional-host`.
- An install refreshes its Git Source before the preview, so the content you
  confirm is the content that is applied. The Updates view refreshes
  the Git Sources in use when you enter it and on `r`.
- The built-in Source is fixed: it is shown as an unselectable row and cannot be
  refreshed or removed.
- Removal is user-global only. Project installations are listed, but project
  uninstall is not supported (`u` on a project row shows a message).
- Unmanaged skills are removed only from the paths listed in the preview. A symlink
  is removed as a link; its target is never touched.
- Batch installs and removals apply item by item; one failure does not stop the
  others and each item reports its own result.

See [CONTEXT.md](CONTEXT.md) for the domain terms and [docs/adr](docs/adr) for the
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
entry points and the module-layer boundaries (`cli` -> `application` -> `core`
-> `infrastructure`; imports may only point downward).

- `pnpm audit:dead-code`: unused files, exports and dependencies, plus
  boundary violations. Must be clean.
- `pnpm audit:dupes`: code duplication (threshold 6%).
- `pnpm audit:health`: complexity and CRAP scores using real coverage; fails
  when the health score drops below 85.
- `pnpm audit:all`: runs the three checks in order.
- `pnpm test:coverage`: runs the tests with built-in V8 coverage
  (`NODE_V8_COVERAGE`, source maps) into `coverage/v8`, which Fallow reads.
  It rebuilds `dist/` with source maps; no extra dependencies are needed.
