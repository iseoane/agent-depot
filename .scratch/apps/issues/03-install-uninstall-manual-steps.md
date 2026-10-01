# 03: Install and uninstall Apps via CLI, with manual steps

**What to build:** `agent-depot app install|uninstall <name> [--yes]` runs the recipe step after a preview and confirmation. Each step falls back to a guided manual step when Agent Depot cannot launch it. The installed state is recorded only when `version` confirms it.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] The preview shows the argv or manual text, the resolved executable path, and the environment.
- [ ] Manual fallback happens only when the process cannot be spawned. A non-zero exit is reported as a failure with its output.
- [ ] After a manual step, the user confirms that it is done, and Agent Depot then runs `version`.
- [ ] After install, the App is recorded as installed only if `version` succeeds. After uninstall, the App is untracked only if `version` fails, or if the user explicitly forgets it.
- [ ] Steps run with the user's home directory as their working directory.
