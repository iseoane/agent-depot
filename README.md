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
