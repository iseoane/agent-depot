# 04: Per-Host setup and teardown for Apps via CLI

**What to build:** `agent-depot app setup|teardown <name> --host <host>... [--yes]` runs the recipe's per-Host steps (argv or manual), with a preview and confirmation.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] Only Hosts that the recipe declares for the requested step are accepted.
- [ ] Manual steps follow the same guided flow as install.
- [ ] A failure on one Host does not stop the remaining selected Hosts, and the result is summarised per Host.
