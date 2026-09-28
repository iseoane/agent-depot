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
```

Refresh first prints the registered URL as a preview. It requires explicit
`--yes` confirmation before any network access and otherwise fails closed. The
package-owned `builtin:agent-depot` Source is listed as read-only and cannot be
refreshed.

Source choice is an application operation, not a CLI discovery command:
`selectSources([sourceId, ...])` receives explicit IDs for one future discovery
call and does not persist a default or perform discovery. The discovery CLI is
planned for ticket 02.

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
