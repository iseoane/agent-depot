# 09: Built-in skill `agent-depot-apprecipe`

**What to build:** A built-in skill in `builtin:agent-depot` that guides an AI agent to research an App without cloning it and write valid recipes, as described in the "AI-assisted recipes" section of `.scratch/apps/spec.md`.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] The skill is platform-aware: it emits one recipe per platform when the steps differ and no `platform` field when they are identical, and it reports unsupported platforms.
- [ ] It detects the actual install channel. When it finds several installs it lists all of them and lets the user choose.
- [ ] It derives update and uninstall from the channel, and prefers the App's own uninstall command when it exists.
- [ ] It separates install from Host setup and teardown, and emits a `manual` step for script-only paths.
- [ ] It runs `agent-depot app validate` for the current platform, marks other platforms as unverified, and reports the license, telemetry, and duplicate install routes.
