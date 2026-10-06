# Host CLI verbs, verified on this machine

Recorded 2026-10-05 against the CLIs installed here: `claude` and `pi`. This
resolves open questions 1 and 2 in `.scratch/packages/spec.md` and corrects one
fact the design got wrong.

## Claude Code

`claude plugin --help` lists `install|i`, `uninstall|remove`, `update`, `list`,
`enable`, `disable`, `marketplace`, `prune|autoremove`, `validate`, `details`,
`configure`, `eval`, `init|new`, `tag`, `test`.

| Action | Verb | Notes |
|---|---|---|
| marketplace add | `claude plugin marketplace add <source>` | `<source>` is a URL, a path, or a GitHub repo. |
| marketplace refresh, scoped | `claude plugin marketplace update <name>` | Without a name it updates every marketplace, which is host-wide. Always pass the name. |
| install | `claude plugin install <plugin>@<marketplace>` | `--json` prints one machine-readable line. |
| update | `claude plugin update <plugin>` | Prints "restart required to apply". |
| uninstall | `claude plugin uninstall <plugin>` | `--keep-data` preserves `~/.claude/plugins/data/{id}/`. |

Two further facts from the help output:

- `--accept-command <sha256>` on install and update. A marketplace entry may
  declare a `command` source, and the install refuses unless the user accepts the
  sha256 of the command a previous `--json` run reported as `shownCommand.sha256`.
  This confirms the design's decision to refuse a bundle-declared `command`
  source in V1. Agent Depot cannot present and accept that command
  non-interactively without a stable mechanism of its own.
- `--config <key=value>` sets a `userConfig` option declared in the plugin
  manifest. V1 does not use it. A plugin that requires a userConfig value will
  install with the value unset, which the host may reject.

## Pi

`pi update --help` lists `--extensions`, `--extension <source>`, `--all`,
`--models`, and `--self`. The short forms include `pi update <source>` for one
package and `pi update --extensions` for all of them.

| Action | Verb |
|---|---|
| install | `pi install <source>` |
| update, scoped | `pi update <source>` |
| update, host-wide | `pi update --extensions` |
| remove | `pi remove <source>` (alias `pi uninstall <source>`) |

`pi install --help` accepts `npm:`, `git:`, a bare `https://` URL, `ssh://`, and
a local path.

## What this corrects

The design and the arena record both claimed that Pi's update is host-wide only,
that `pi update <source>` is ungrounded, and that the Claude update and uninstall
verbs were unverified. All three are wrong for the installed versions.

- V1 uses the scoped verb for every action. Every V1 action therefore affects
  exactly the selection.
- `plan.affects` stays. It is still the one place that must change if a host-wide
  verb is ever chosen, and `claude plugin marketplace update` without a name is a
  live trap the type guards against. The V1 adapter returns the selection's own
  coordinates.
- The design's `HOST_STEP_TEMPLATES` for `pi.update` changes from
  `["pi","update","--extensions"]` to `["pi","update",<source>]`, and
  `claude.update` and `claude.uninstall` move from TODO to verified.
- The refusal of a bundle-declared `command` marketplace source is now grounded
  in `--accept-command`, not just in caution.
