# Host bundle formats: primary-source facts

Scope: Pi packages and Claude Code plugins, the two formats the Package category
must handle first. Codex and OpenCode packaging stay recognized-but-deferred.

## Pi packages

Source: the local Pi documentation, `docs/packages.md` and `pi install --help`, on
this machine at `/home/iseoane/.pi/agent/install/releases/1.0.3/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`.

- A package is an ordinary directory or npm package. Pi collects it as one unit of
  extensions, skills, prompt templates, and themes.
- Discovery without a manifest uses the conventional directories `extensions/`,
  `skills/`, `prompts/`, and `themes/` at the package root.
- An explicit manifest lives under the `pi` key of `package.json` and gives arrays
  of paths that accept glob patterns and exclusions. The example from the docs:
  `{"pi": {"extensions": ["./src/extension.ts"], "skills": ["./resources/skills"], "prompts": ["./resources/prompts/*.md"], "themes": ["./resources/themes/*.json"]}}`.
  Paths are relative to the package root.
- The `pi-package` keyword in `package.json` makes an npm package eligible for the
  Pi gallery. `pi.image` and `pi.video` add previews.
- Install sources and forms. `pi install npm:@example/pi-tools@1.0.0`,
  `pi install git:github.com/example/pi-tools@v1`, `pi install ./local-package`,
  and a bare URL is treated as a git source.
- Where an install is recorded. Personal installs go to
  `~/.pi/agent/settings.json`. `-l` or `--local` writes `.pi/settings.json`
  instead, which Pi reads only after project trust.
- Identity. Pi identifies npm packages by package name, git packages by repository
  URL without the ref, and local packages by resolved absolute path. That is what
  stops the same package loading twice through equivalent declarations.
- Version pinning. A versioned npm spec is pinned. A git tag or commit is pinned.
  `pi update --extensions` reconciles the checkout and does not move a configured
  ref.
- Per-resource narrowing. The object form in settings accepts `extensions`,
  `skills`, `prompts`, and `themes` arrays. Omit a property to load everything the
  package allows, `[]` to load none, `!pattern` to exclude glob matches, `+path` to
  include one exact path, and `-path` to exclude one exact path. Filters narrow the
  package manifest. They cannot expose a resource the package did not declare.
- Scope and override. The same package can appear in personal and project
  settings. A project entry normally replaces the personal entry. With
  `autoload: false` the project entry is a filtering delta over the personal one.
- Management commands. `pi list` shows configured packages with their source and
  install path. `pi remove <source>` drops a declaration. `pi config` toggles
  discovered resources per scope.
- Dependency rules. Runtime imports go in `dependencies`. Host packages
  (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) go in
  `peerDependencies` with `"*"`. Pi installs package dependencies for npm and git
  sources.

Observed on this machine from `pi list`. A git package prints as
`git:github.com/michael-denyer/pstack-claude` with its install path under
`~/.pi/agent/git/`. npm packages print as `npm:<name>@<version>` under
`~/.pi/agent/npm/node_modules/`. `pi list` prints no separate version number for a
git package.

## Claude Code plugins

Sources: `https://code.claude.com/docs/en/plugins/overview`,
`.../plugins/manifest-reference`, `.../plugins/marketplace-reference`, and
`.../plugins/loading`.

- A plugin is a directory of components with a manifest at
  `.claude-plugin/plugin.json`. Components are skills, agents, hooks, a hooks
  module (a mod), MCP servers, and also commands, LSP servers, output styles,
  workflows, monitors, themes, and channels.
- Everything except the manifest lives at the plugin root, not inside
  `.claude-plugin/`.
- `name` is the only required manifest field. Other fields include `displayName`,
  `version`, `description`, `author` (`name` required plus `email` and `url`),
  `homepage`, `repository`, `license`, `keywords`, `metadata`, `defaultEnabled`,
  `dependencies`, `settings`, `userConfig`, and `channels`.
- Component keys in the manifest. `agents`, `skills`, `outputStyles`, `workflows`,
  and `experimental.themes` take one path or an array of paths. `agents` entries
  must be `.md` files. `skills` entries must be directories. `commands` takes a
  path, an array, or an object map. `hooks` takes a `.json` path, an inline object,
  or an array mixing them. `mcpServers` takes a `.json` path, a bundle path or URL,
  an inline map, or an array. `lspServers` takes a `.json` path, an inline map, or
  an array.
- How a component key combines with its default location. `skills` adds to the
  default `skills/` directory. `commands`, `agents`, `outputStyles`, `workflows`,
  `experimental.themes`, and `experimental.monitors` replace their default folder.
  `hooks`, `mcpServers`, and `lspServers` merge with their default file.
- Default locations at the plugin root are `skills/`, `commands/`, `agents/`,
  `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`,
  `themes/`, and `monitors/monitors.json`.
- Version semantics. Setting `version` in `plugin.json` keeps users on that
  version until it changes. A `version` in the marketplace entry overrides the
  `plugin.json` one.
- A marketplace is a repository or directory with a
  `.claude-plugin/marketplace.json` file. Top-level `name`, `owner`, and `plugins`
  are required. It also accepts `$schema`, `description`, `version`,
  `metadata.pluginRoot`, `renames`, and dependency fields.
- Each object in `plugins` needs `name` and `source`, and accepts every
  `plugin.json` field, such as `description`, `version`, `author`, `commands`, and
  `hooks`.
- Plugin source types. A relative path string that starts with `./` and resolves
  from the marketplace root, a bare name under `metadata.pluginRoot`, or an object
  with one of these shapes:
  - `github`: `repo` in `owner/repo` form, plus optional `ref` and `sha`.
  - `url`: a full git URL, plus optional `ref` and `sha`.
  - `git-subdir`: `url` (full URL or `owner/repo`), `path`, plus optional `ref` and
    `sha`. Fetched with a sparse checkout.
  - `npm`: `package`, plus optional `version` and `registry`. Fetched with the npm
    client and unpacked without running install scripts.
  - `archive`: `url` over HTTPS plus `sha256`.
  - `command`: `command`, plus optional `timeout` and `mode`, where the command
    prints a directory. Requires Claude Code v2.1.229 or later.
- When both `ref` and `sha` are set, Claude Code checks out `sha`.
- Install commands. `claude plugin marketplace add <source>` then
  `claude plugin install <plugin>@<marketplace>`. Scopes are user, project through
  a committed `.claude/settings.json`, and local to one repository.
- Where state lives. Settings hold `enabledPlugins` and `extraKnownMarketplaces`.
  On disk under `~/.claude/plugins/`, `known_marketplaces.json` records each
  marketplace with its `source`, `installLocation`, `lastUpdated`, and
  `autoUpdate`, `installed_plugins.json` records each install with its `scope`,
  `installPath`, and `version`, and `cache/` holds the plugin files.
- Validation. `claude plugin validate <dir>` checks JSON syntax, required fields,
  naming rules, a relative source with `..`, unknown fields as warnings, and the
  `plugin.json` of each relative-path plugin.
- Naming rules. A marketplace `name` uses letters, digits, `.`, `_`, and `-`,
  starts with a letter or digit, and has no `..`. A plugin's marketplace entry
  `name` should equal its `plugin.json` `name`. The entry name is the install id
  and the key under `enabledPlugins`. The manifest name is the prefix on the
  plugin's skills.

Observed on this machine. `claude plugin marketplace list` shows only the built-in
`anthropic-plugin-directory`. `claude plugin list` prints `No plugins installed`.
`~/.claude/settings.json` has only a `hooks` key, so no `enabledPlugins` entry
exists yet.

## The worked example, pstack-claude

One repository is both formats.

- `package.json` declares `keywords: ["pi-package", ...]`, `pi.skills:
  ["./plugins/pstack/skills"]`, and `pi.extensions: ["./plugins/pstack/pi/index.ts"]`.
  It also declares `peerDependencies` on `@earendil-works/pi-coding-agent` and
  `typebox`.
- `.claude-plugin/marketplace.json` has `name: "pstack-claude"` and one plugin
  entry, `pstack`, with `source: "./plugins/pstack"` and `version: "0.9.69"`.
- `plugins/pstack/.claude-plugin/plugin.json` has `name: "pstack"`, `version:
  "0.9.69"`, and `agents` listing twelve `.md` files: three under `agents/` and
  nine under `effort-agents/`.
- `plugins/pstack/skills/` holds the shared skills. `plugins/pstack/pi/` holds the
  Pi extension. `plugins/pstack/hooks/` and `plugins/pstack/.codex-plugin/` exist
  too.
- The skills reference plugin agents by name, such as `pstack:poteto-agent` and
  `pstack:comment-sicko`, and the Pi extension supplies the `agent`,
  `send_message`, `list_agents`, `ask_user_question`, and `schedule_wakeup` tools
  that poteto-mode's fan-out needs.

## What Agent Depot accepts today

- `canonicalizeGitSourceUrl` accepts the `git:`, `http:`, `https:`, and `ssh:`
  protocols and then rejects any URL with an empty hostname. Verified against
  `dist/src/git-source.js`: `git:github.com/michael-denyer/pstack-claude` fails
  with `Git Source URL contains unsupported or unsafe components`.
- `https://github.com/michael-denyer/pstack-claude/tree/main/plugins/pstack`
  canonicalizes and resolves to `repository: michael-denyer/pstack-claude`,
  `ref: main`, `directory: plugins/pstack`.
- `discoverSkillsFromSources` reads every file in the Source snapshot and keeps
  only `basename === "SKILL.md"` with frontmatter that yields `name` and
  `description`. It excludes paths with a segment named `in-progress`, `beta`,
  `deprecated`, or `retired`. It reads no manifest of any kind.

## Consequence for the design

A Package resource is a host-native bundle with a manifest, a per-host loader, a
version signal, and a lifecycle the host CLI owns. The four hosts agree on none of
those except that skills are directories with `SKILL.md`. The design must not
pretend the bundle formats converge.
