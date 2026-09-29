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
node dist/src/cli.js install --scope user-global --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --yes
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

## User-global installation

User-global installations use the same canonical Host locations under the user
home directory (`.agents/skills/<skill>` and, when requested, a Claude symlink
at `.claude/skills/<skill>`). They are independent from project manifests and
are recorded in the shared per-user Source state, so separate CLI invocations
reuse the same installation records. The selected Source, Skill, Hosts, and
actual adopted or installed location are previewed before `--yes` confirmation.

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
