# 21: Discovery reports a non-Pi skill repository and a duplicate Claude bundle

**What is wrong:** Discovery treats any scope-root `package.json` with no `pi`
key as a conventional Pi package whenever a `skills/` directory holds files.
`skills/` and `themes/` are also Claude Code default locations, so a repository
that ships shared skills for Claude is reported as a Pi bundle. Separately, a
Claude marketplace entry whose `source` is `"."` or `"./"` normalizes to the
empty relative path and was read as an external source, so the entry yielded a
marketplace-only bundle with no version and the root plugin was reported a second
time as unbound.

**Reported shape:** `mattpocock/skills` listed three Packages from one Source,
`mattpocock-skills (pi) 1.3.1`, `mattpocock-skills (claude) unknown`, and
`mattpocock-skills (claude) 1.3.1`, and its `tdd` and `teach` skills were dimmed
as provided by the Pi bundle.

**User impact:** An ordinary skill repository is shown as a Pi package the user
cannot meaningfully install on Pi, and the one Claude plugin appears twice, once
with no version. The false Pi bundle also takes ownership of every skill, so the
skills cannot be installed as portable skills.

**What ships now:** `discoverBundlesInSnapshot` recognizes a conventional Pi
bundle only when the repository shows Pi intent: a `pi-package` keyword, or an
`extensions/` or `prompts/` directory that holds files. A `pi` key still
short-circuits the check and an explicit manifest is unchanged. A marketplace
`source` of `"."` or `"./"` binds the marketplace root plugin in repo, so the
entry and the root plugin produce one descriptor.

**For the CLI and TUI waves:** the Catalog Package group shows one Claude bundle
for `mattpocock/skills`, at version 1.3.1, with no Pi bundle and no duplicate.

**Status:** completed

- [x] A scope-root `package.json` with only a shared `skills/` directory yields no Pi bundle.
- [x] The `pi-package` keyword still yields a Pi bundle whose only resource is skills.
- [x] A Pi-native `extensions/` directory still yields a conventional Pi bundle.
- [x] A marketplace entry with `source: "."` or `"./"` binds the root plugin once, with the plugin manifest version.
- [x] The Matt fixture yields exactly one descriptor, host `claude`, name `mattpocock-skills`, version 1.3.1, and no warnings.
- [x] The owned-skill guard attributes `tdd` and `teach` to the Claude bundle.
- [x] Existing dual-format, scoped-Source, unbound-plugin, and manifest-digest behavior is unchanged.

## Verification

- `tests/package-bundles.test.ts` passes, including the six assertions above.
- Real read-only mirror, `https://github.com/mattpocock/skills`:
  `discoverBundlesInSnapshot` yields one descriptor, `claude mattpocock-skills 1.3.1`,
  and the flow-level `discover` yields the same one.
- `claude plugin validate` on the repository root reports `success: true` with
  `source: "./"` in the marketplace entry bound to the root `plugin.json`, so the
  relative root source is a genuine format rather than a guess.

## Domain fork settled in issue 22

`mattpocock/skills` names all 27 skills in its plugin manifest, so under a
structural reading the Claude bundle would own them and the guard would refuse to
install `tdd` or `teach` as portable skills with no bundle chosen. This change
left that reading in place and recorded the fork.

The user settled the fork in favor of selection-gated ownership. A discovered
descriptor owns its Skills only while the user selected the Package or a host
state file proves it installed; the full rule, the portable-duplicate refusal,
and the Catalog behavior are in issue 22. ADR 0009 carries an amendment that
supersedes the structural reading here.

## Limitations

- A genuine conventional Pi package whose only resource directory is `skills/`
  or `themes/`, with no `pi-package` keyword, is no longer discovered. That case
  is indistinguishable from an ordinary shared skill repository, and recognizing
  it is what produced the false positive. Adding the keyword or an explicit `pi`
  key restores discovery.
- Pi also recognizes a package directory with no `package.json` at all. Agent
  Depot still requires a scope-root `package.json`, unchanged from before.

## Comments

- 2026-10-06 (bug fix, base fad0ead): completed. Evidence:
  `tests/package-bundles.test.ts`; the real-mirror reproduction; `claude plugin validate`.
