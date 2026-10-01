# 09: Built-in skill `agent-depot-apprecipe`

**What to build:** A built-in skill in `builtin:agent-depot` that guides an AI agent to research an App without cloning it and write valid recipes, as described in the "AI-assisted recipes" section of `.scratch/apps/spec.md`.

**Blocked by:** 02.

**Status:** completed

- [x] The skill is platform-aware: it emits one recipe per platform when the steps differ and no `platform` field when they are identical, and it reports unsupported platforms.
- [x] It detects the actual install channel. When it finds several installs it lists all of them and lets the user choose.
- [x] It derives update and uninstall from the channel, and prefers the App's own uninstall command when it exists.
- [x] It separates install from Host setup and teardown, and emits a `manual` step for script-only paths.
- [x] It runs `agent-depot app validate` for the current platform, marks other platforms as unverified, and reports the license, telemetry, and duplicate install routes.

## Implementation evidence

- Built-in Skill: `skills/agent-depot-apprecipe/SKILL.md`; fictional format example in `assets/example.md`, not a shipped App recipe.
- Reused recursive built-in Source discovery and existing package `skills` inclusion; no runtime schema or CLI changes.
- TDD: `tests/apprecipe-skill.test.ts` failed for missing discovery/content, then passed both tests for discovery/frontmatter/CLI installation and every fenced JSON recipe in bundled Markdown through `parseAppRecipe`.
- Verification: `pnpm typecheck`, `pnpm lint`, full `pnpm test` (639 passed), `pnpm test:e2e` (2 passed), `pnpm test:pack` (passed, including installed-tarball Skill discovery/install and support-file equality). Focused lifecycle file: 9 passed.
- Review boundary: starting commit `80763231e5ec2a593f29c74ddc2c9c855fe841fd`. Standards and Spec reviewed separately in-session (parallel sub-agent tooling unavailable); no remaining findings. Used the bundled skill-creator style guide because no repo guide exists.
- Rollback: remove the new Skill directory and `tests/apprecipe-skill.test.ts`, and revert the built-in count/list expectations and pack smoke additions; no App runtime behavior changes.
