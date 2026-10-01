# 08: Exclude App-owned skills from the unmanaged inventory

**What to build:** The recipe's `skills` names or globs mark skills that the App installs itself. They are excluded from the unmanaged-skill adopt and remove flows, both in the CLI and in the Unmanaged group of the TUI.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] A skill matching any applicable recipe's `skills` entry is not listed as unmanaged and cannot be adopted or removed through that flow.
- [ ] Agent Depot verifies nothing about those paths.
