# 01: Profile format and `agent-depot export`

**What to build:** The versioned `agent-depot-profile/v1` format (strict parser and serializer in a core module) and `agent-depot export [--out <file>]` with filters (`--no-sources`, `--no-skills`, `--no-apps`, repeatable `--source/--skill/--app`), as defined in `.scratch/profile/spec.md`. Record the profile feature and the new TUI tab in an ADR.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] The profile contains Git Sources, user-global Skill selections (Source identity, path, version policy, Hosts, methods) and App recipe contents, and nothing machine-specific.
- [ ] Local-path Sources, the built-in Source, unmanaged and App-owned Skills, approvals and installed state are excluded; the preview says why.
- [ ] The parser rejects unknown versions, unknown fields, local paths and invalid recipes with field paths.
- [ ] Export round-trips: parsing an exported profile yields the same content.
