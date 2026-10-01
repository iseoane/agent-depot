# 05: App updates via CLI

**What to build:**
- Resolve each App's latest version from `latest`: the GitHub Releases API, the npm registry, or an argv with a pattern.
- `agent-depot app update <name>` runs the recipe's update step.
- Apps appear in `update check` and `update apply` alongside skills.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] When `latest` is missing or unresolvable, the status is unknown and the App is not offered as an update.
- [ ] `update apply` selects Apps together with skills, and one App's failure does not stop the others.
- [ ] After an update, `version` confirms the new installed version.
- [ ] Tests stub the GitHub and npm responses.
