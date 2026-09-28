# Agent Depot

Agent Depot keeps a global catalog of Git Sources for future skill discovery.

## Usage

Build the package, then run the CLI:

```sh
pnpm build
node dist/src/cli.js source list
node dist/src/cli.js source add https://github.com/example/skills.git
node dist/src/cli.js source refresh git:<source-id>
node dist/src/cli.js source refresh git:<source-id> --yes
node dist/src/cli.js discover builtin:agent-depot git:<source-id>
node dist/src/cli.js install --scope project --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --yes
node dist/src/cli.js install --scope project --manifest --portable-v1 --yes
```

Refresh first prints the registered URL as a preview. It requires explicit
`--yes` confirmation before any network access and otherwise fails closed. The
package-owned `builtin:agent-depot` Source is listed as read-only and cannot be
refreshed.

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

## Project installation

Project installation requires an explicit `--scope project`, Source ID, Skill
path, one or more `--host` values (`pi`, `claude`, `codex`, or `opencode`), and
a version policy (`--version latest` or `--version fixed:<value>`). External
Sources require a fixed 40- or 64-character Git commit. For the built-in
Source, `latest` tracks the installed Agent Depot package, while a fixed policy
is accepted only when its value exactly equals that package's current version;
other values fail closed because the requested package version cannot be
reproduced. The built-in Source does not support `--ref`, and the CLI rejects it
explicitly. External `latest` may track an explicit mutable safe ref, but an
immutable commit ref must use a fixed policy matching that commit. The
`--portable-v1` flag requires the validated portable format rule; compatibility
is derived from source bytes and exclusions rather than trusted from a caller
assertion. It previews every file and the Claude symlink, then requires `--yes`
before writing.

A confirmed installation writes `agent-depot.json` in the project root. The
manifest stores built-in identity or an external canonical URL, Skill path,
version policy, and Hosts, so `install --scope project --manifest` can resolve
it without the global Source catalog. Portable manifests reject local path
Sources because their identity is not independently resolvable. External Git
Sources are refreshed only
after confirmation.

The complete Skill tree is copied byte-for-byte and existing paths are never
overwritten. Claude is exposed through a symlink to the canonical
`.agents/skills/<skill>` installation.

A Source may declare an installation method only through an explicit JSON
metadata file inside the selected Skill (`.agent-depot.json`,
`agent-depot-method.json`, or `installation-method.json`), never from
`SKILL.md` prose. The file may contain either the method object or
`{ "method": { "kind": "command", "argv": ["executable", "arg", ...],
"cwd": "optional/project-relative-directory" } }`. The executable must be a
bare safe command name, `cwd` must remain below the project root after realpath
resolution, and shell syntax, control characters, unsupported fields, and OS-
specific shell interpreters are refused. Metadata is read from the same
immutable tree snapshot as the preview; confirmation never triggers a mutable
latest re-read. The exact executable, argument array, working directory, and
complete file list are previewed before `--yes`; execution uses a child process
with `shell: false` and never interpolates a shell command. Commands are not
inferred from `SKILL.md` prose. A confirmed method still goes through
compatibility validation, canonical installation, and the Claude symlink path.
The manifest is persisted before an external method runs. If that method fails,
its side effects cannot be rolled back, so the installed files and manifest are
retained and the failure does not claim rollback. Method-containing batch
installs are refused because arbitrary child-process side effects are
non-rollbackable. Manifest entries that identify an external local path are
refused by the Git-only resolver with an actionable unsupported-source error;
URL Sources remain self-contained and resolvable on a fresh machine.

## Configuration and cache

The Source catalog is stored globally at:

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
