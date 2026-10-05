# 04: package-host-state.ts read-only host state boundary

**What to build:** The boundary that turns the host's own state files into
installed evidence, per section 4.1 of `.scratch/packages/design.md`.

- `parsePiPackagesSetting` for `~/.pi/agent/settings.json`. Accept the bare string
  form, the `@commit` pin form, and the object narrowing form. An unknown shape
  yields a record with undefined commit rather than a throw.
- `parseClaudePluginState` for `~/.claude/plugins/installed_plugins.json`,
  carrying scope, install path, and version.
- `parseClaudeMarketplaceState` for `~/.claude/plugins/known_marketplaces.json`.
- `readHostInstallView` with the injectable `readHostStateFile` seam. A missing
  file is an empty view. A drifted or undecodable file degrades the affected
  lookups to `unknown`.
- `findInstalledBundle`: Pi identity is the repository URL without the ref, Claude
  identity is `<plugin>@<marketplace>`.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] The observed `settings.json` shapes from this machine parse into the expected records, including the `@commit` pin.
- [ ] Drifted JSON produces `unknown` evidence and never throws.
- [ ] A missing host state file produces an empty view, not an error.
- [ ] An npm-shaped Pi record never matches a git bundle selection.
- [ ] No module in this unit writes to any host state file.

## Verification

- `tests/package-host-state.test.ts` writes fixture host files into an isolated temporary home.
- A read-only home test proves nothing is written.
